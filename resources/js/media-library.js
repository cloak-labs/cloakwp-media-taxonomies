/**
 * Media Taxonomies — admin media library enhancements.
 *
 * - Grid / modal taxonomy filters (one per registered taxonomy)
 * - Bulk-select "Edit taxonomies" button + panel
 * - Attachment sidebar "Add New" term
 * - List-view bulk assign panel
 */
(function (window, $) {
  'use strict';

  var settings = window.mediaTaxonomiesAdmin || null;
  if (!settings) {
    return;
  }

  var taxonomies = settings.taxonomies || [];
  var uncategorized = settings.uncategorized || 'uncategorized';
  var labels = settings.labels || {};
  var openFilterView = null;
  var filterDocBound = false;
  var categoryFilterViews = [];

  function taxBySlug(slug) {
    slug = String(slug || '');
    for (var i = 0; i < taxonomies.length; i++) {
      if (taxonomies[i] && taxonomies[i].slug === slug) {
        return taxonomies[i];
      }
    }
    return null;
  }

  function taxLabels(tax) {
    return (tax && tax.labels) || {};
  }

  // WP persists term names via _wp_specialchars (`&` → `&amp;`). Decode once so
  // later .text()/escapeHtml() encode for HTML instead of showing a literal entity.
  function decodeHtmlEntities(text) {
    if (text == null || text === '') {
      return '';
    }
    return $('<textarea></textarea>').html(String(text)).val();
  }

  taxonomies.forEach(function (tax) {
    (tax.terms || []).forEach(function (term) {
      if (term) {
        term.name = decodeHtmlEntities(term.name);
      }
    });
  });

  function termPrefix(depth) {
    var prefix = '';
    var d = parseInt(depth, 10) || 0;
    while (d-- > 0) {
      prefix += '- ';
    }
    return prefix;
  }

  function encodeFilterValue(mode, selected) {
    selected = selected || [];
    if (!selected.length) {
      return '';
    }
    if (selected.indexOf(uncategorized) !== -1) {
      return mode === 'not' ? 'not:' + uncategorized : uncategorized;
    }
    var ids = selected
      .map(function (id) {
        return parseInt(id, 10);
      })
      .filter(function (id) {
        return id > 0;
      });
    if (!ids.length) {
      return '';
    }
    var joined = ids.join(',');
    return mode === 'not' ? 'not:' + joined : joined;
  }

  function parseFilterValue(value) {
    var raw = $.trim(String(value == null ? '' : value));
    var mode = 'in';
    if (raw.indexOf('not:') === 0) {
      mode = 'not';
      raw = $.trim(raw.slice(4));
    }
    if (!raw || raw === '0') {
      return { mode: mode, selected: [] };
    }
    if (raw === uncategorized) {
      return { mode: mode, selected: [uncategorized] };
    }
    var selected = raw
      .split(',')
      .map(function (part) {
        return parseInt($.trim(part), 10);
      })
      .filter(function (id) {
        return id > 0;
      });
    return { mode: mode, selected: selected };
  }

  function bindFilterDocumentEvents() {
    if (filterDocBound) {
      return;
    }
    filterDocBound = true;
    $(document).on('click.mediaCategoriesFilter', function (e) {
      if (!openFilterView) {
        return;
      }
      if ($(e.target).closest('.media-categories-filter-wrap').length) {
        return;
      }
      openFilterView.closePanel();
    });
    $(document).on('keydown.mediaCategoriesFilter', function (e) {
      if ((e.key === 'Escape' || e.keyCode === 27) && openFilterView) {
        openFilterView.closePanel();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Shared bulk panel                                                  */
  /* ------------------------------------------------------------------ */

  var $bulkPanel = null;
  var currentBulkIds = [];
  var bulkSelectController = null;
  var bulkTermsAbort = null;
  var bulkTermsRequestId = 0;

  function bulkTermOptionsHtml() {
    return taxonomies
      .map(function (tax) {
        var heading =
          '<p class="media-categories-bulk-heading">' +
          $('<div>').text(taxLabels(tax).plural || tax.slug).html() +
          '</p>';
        var rows = (tax.terms || [])
          .map(function (term) {
            return (
              '<label class="media-categories-bulk-term">' +
              '<input type="checkbox" value="' +
              term.id +
              '" data-taxonomy="' +
              tax.slug +
              '" /> ' +
              $('<div>').text(termPrefix(term.depth) + term.name).html() +
              '</label>'
            );
          })
          .join('');
        return heading + rows;
      })
      .join('');
  }

  function renderBulkTerms(checkedIds) {
    if (!$bulkPanel) {
      return;
    }
    var checked = (checkedIds || []).map(String);
    $bulkPanel.find('.media-categories-bulk-terms').html(bulkTermOptionsHtml());
    if (checked.length) {
      $bulkPanel.find('.media-categories-bulk-terms input[type="checkbox"]').each(function () {
        this.checked = checked.indexOf(String(this.value)) !== -1;
      });
    }
  }

  function refreshFilterTermLists() {
    categoryFilterViews.forEach(function (view) {
      if (!view || !view.$el || !view.$el.length) {
        return;
      }
      var $box = view.$('.media-categories-filter-terms');
      if (!$box.length) {
        return;
      }
      $box.html(view.termRowsHtml());
      if (typeof view.syncPanelState === 'function') {
        view.syncPanelState();
      }
      if (typeof view.updateToggleLabel === 'function') {
        view.updateToggleLabel();
      }
    });
  }

  function applyFetchedTerms(groups) {
    (groups || []).forEach(function (group) {
      var tax = taxBySlug(group.slug);
      if (!tax) {
        return;
      }
      tax.terms = (group.terms || []).map(function (term) {
        return {
          id: parseInt(term.id, 10),
          name: decodeHtmlEntities(term.name),
          slug: term.slug,
          parent: parseInt(term.parent, 10) || 0,
          count: parseInt(term.count, 10) || 0,
          depth: parseInt(term.depth, 10) || 0,
        };
      });
    });
    renderBulkTerms(selectedTermIds());
    refreshFilterTermLists();
    $('.media-categories-attachment-field').each(function () {
      syncSidebarField($(this));
    });
  }

  function setBulkRefreshBusy(busy) {
    if (!$bulkPanel) {
      return;
    }
    var $btn = $bulkPanel.find('.media-categories-bulk-refresh');
    $btn.prop('disabled', !!busy).toggleClass('is-busy', !!busy);
    $btn.attr('aria-busy', busy ? 'true' : 'false');
  }

  function refreshBulkTerms() {
    if (!window.wp || !wp.apiFetch) {
      if ($bulkPanel) {
        $bulkPanel
          .find('.media-categories-bulk-status')
          .text(labels.refreshError || 'Could not refresh terms.');
      }
      return;
    }

    if (bulkTermsAbort && typeof bulkTermsAbort.abort === 'function') {
      bulkTermsAbort.abort();
    }
    bulkTermsAbort =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    var requestId = ++bulkTermsRequestId;

    var $status = $bulkPanel ? $bulkPanel.find('.media-categories-bulk-status') : $();
    setBulkRefreshBusy(true);
    if ($status.length) {
      $status.text('');
    }

    wp.apiFetch({
      path: '/media-taxonomies/v1/terms',
      signal: bulkTermsAbort ? bulkTermsAbort.signal : undefined,
    })
      .then(function (data) {
        if (requestId !== bulkTermsRequestId) {
          return;
        }
        applyFetchedTerms(Array.isArray(data) ? data : []);
      })
      .catch(function (error) {
        if (requestId !== bulkTermsRequestId) {
          return;
        }
        if (error && error.name === 'AbortError') {
          return;
        }
        if ($status.length) {
          $status.text(labels.refreshError || 'Could not refresh terms.');
        }
      })
      .then(function () {
        if (requestId !== bulkTermsRequestId) {
          return;
        }
        bulkTermsAbort = null;
        setBulkRefreshBusy(false);
      });
  }

  function ensureBulkPanel() {
    if ($bulkPanel) {
      return $bulkPanel;
    }

    var refreshLabel = labels.refresh || 'Refresh terms';

    $bulkPanel = $(
      '<div class="media-categories-bulk-panel hidden" role="dialog" aria-label="' +
        (labels.bulkEdit || 'Edit media taxonomies') +
        '">' +
        '<div class="media-categories-bulk-panel__inner">' +
        '<div class="media-categories-bulk-panel__header">' +
        '<p class="media-categories-bulk-panel__title"></p>' +
        '<button type="button" class="media-categories-bulk-refresh" aria-label="' +
        $('<div>').text(refreshLabel).html() +
        '">' +
        '<span class="dashicons dashicons-update" aria-hidden="true"></span>' +
        '</button>' +
        '</div>' +
        '<div class="media-categories-bulk-terms"></div>' +
        '<div class="media-categories-bulk-actions">' +
        '<button type="button" class="button button-primary media-categories-bulk-add">' +
        (labels.addToSelected || 'Add to selected') +
        '</button> ' +
        '<button type="button" class="button media-categories-bulk-remove">' +
        (labels.removeFromSelected || 'Remove from selected') +
        '</button> ' +
        '<button type="button" class="button-link media-categories-bulk-cancel">' +
        (labels.cancel || 'Cancel') +
        '</button>' +
        '</div>' +
        '<p class="media-categories-bulk-status" aria-live="polite"></p>' +
        '</div>' +
        '</div>'
    );

    $('body').append($bulkPanel);
    renderBulkTerms();

    $bulkPanel.on('click', '.media-categories-bulk-cancel', closeBulkPanel);
    $bulkPanel.on('click', '.media-categories-bulk-refresh', function (e) {
      e.preventDefault();
      refreshBulkTerms();
    });
    $bulkPanel.on('click', '.media-categories-bulk-add', function () {
      submitBulk(true);
    });
    $bulkPanel.on('click', '.media-categories-bulk-remove', function () {
      submitBulk(false);
    });

    return $bulkPanel;
  }

  function openBulkPanel(ids, $anchor, controller) {
    var $panel = ensureBulkPanel();
    currentBulkIds = ids || [];
    bulkSelectController = controller || null;
    $panel
      .find('.media-categories-bulk-panel__title')
      .text(
        (labels.bulkEdit || 'Edit media taxonomies') +
          ' (' +
          currentBulkIds.length +
          ')'
      );
    $panel.find('input[type="checkbox"]').prop('checked', false);
    $panel.find('.media-categories-bulk-status').text('');
    $panel.removeClass('hidden');
    positionBulkPanel($anchor);
  }

  /**
   * Panel is position:fixed (viewport). jQuery offset() is document-relative,
   * so after scrolling the library it would place the panel thousands of
   * pixels below the screen. Use the anchor's visible box instead.
   */
  function positionBulkPanel($anchor) {
    if (!$bulkPanel) {
      return;
    }

    var gutter = 16;
    var margin = 8;
    var panelWidth = $bulkPanel.outerWidth() || 280;
    var panelHeight = $bulkPanel.outerHeight() || 320;
    var viewportW = window.innerWidth;
    var viewportH = window.innerHeight;
    var top = Math.max(gutter, 80);
    var left = Math.max(gutter, (viewportW - panelWidth) / 2);

    if ($anchor && $anchor.length) {
      var rect = $anchor[0].getBoundingClientRect();
      top = rect.bottom + margin;
      left = rect.left;

      if (left + panelWidth > viewportW - gutter) {
        left = viewportW - panelWidth - gutter;
      }
      if (left < gutter) {
        left = gutter;
      }

      if (top + panelHeight > viewportH - gutter) {
        var above = rect.top - panelHeight - margin;
        top = above >= gutter ? above : Math.max(gutter, viewportH - panelHeight - gutter);
      }
    }

    $bulkPanel.css({ top: Math.round(top), left: Math.round(left) });
  }

  function closeBulkPanel() {
    if (bulkTermsAbort && typeof bulkTermsAbort.abort === 'function') {
      bulkTermsAbort.abort();
      bulkTermsAbort = null;
    }
    bulkTermsRequestId += 1;
    if ($bulkPanel) {
      $bulkPanel.addClass('hidden');
      setBulkRefreshBusy(false);
      $bulkPanel.find('.media-categories-bulk-status').text('');
    }
    currentBulkIds = [];
    bulkSelectController = null;
  }

  function exitBulkSelectMode() {
    var controller = bulkSelectController;
    if (controller && typeof controller.trigger === 'function') {
      controller.trigger('selection:action:done');
    }
    if (controller && typeof controller.isModeActive === 'function' && !controller.isModeActive('select')) {
      return;
    }
    var $toggle = $('.media-toolbar-mode-select .select-mode-toggle-button');
    if ($toggle.length) {
      $toggle.trigger('click');
    }
  }

  function selectedTermIds() {
    if (!$bulkPanel) {
      return [];
    }
    return $bulkPanel
      .find('.media-categories-bulk-terms input:checked')
      .map(function () {
        return parseInt(this.value, 10);
      })
      .get();
  }

  function selectedTermsByTaxonomy() {
    var grouped = {};
    if (!$bulkPanel) {
      return grouped;
    }
    $bulkPanel.find('.media-categories-bulk-terms input:checked').each(function () {
      var slug = this.getAttribute('data-taxonomy') || '';
      var id = parseInt(this.value, 10);
      if (!slug || id <= 0) {
        return;
      }
      if (!grouped[slug]) {
        grouped[slug] = [];
      }
      grouped[slug].push(id);
    });
    return grouped;
  }

  function submitBulk(append) {
    var grouped = selectedTermsByTaxonomy();
    var slugs = Object.keys(grouped);
    if (!slugs.length) {
      $bulkPanel
        .find('.media-categories-bulk-status')
        .text('Select at least one term.');
      return;
    }

    var $status = $bulkPanel.find('.media-categories-bulk-status');
    $status.text('Updating…');

    Promise.all(
      slugs.map(function (slug) {
        return fetch(settings.restUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-WP-Nonce': settings.nonce,
          },
          credentials: 'same-origin',
          body: JSON.stringify({
            attachment_ids: currentBulkIds,
            taxonomy: slug,
            term_ids: grouped[slug],
            append: append,
          }),
        }).then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        });
      })
    )
      .then(function (results) {
        var failed = results.filter(function (result) {
          return !result.ok;
        })[0];
        if (failed) {
          $status.text(
            (failed.data && failed.data.message) ||
              labels.bulkError ||
              'Could not update taxonomies.'
          );
          return;
        }

        var updated = {};
        results.forEach(function (result) {
          (result.data.updated || []).forEach(function (id) {
            updated[id] = true;
          });
        });
        var count = Object.keys(updated).length;
        var isListBulk =
          window.location.search.indexOf('media_taxonomies_bulk') !== -1 ||
          window.mediaTaxonomiesBulkIds;

        if (window.wp && wp.media && wp.media.frame) {
          var library = wp.media.frame.state().get('library');
          if (library && library.props) {
            library.props.set({ ignore: +new Date() });
          }
        }

        if (isListBulk) {
          $status.text(
            (labels.bulkSuccess || 'Taxonomies updated.') + ' (' + count + ')'
          );
          setTimeout(function () {
            closeBulkPanel();
            var url = new URL(window.location.href);
            url.searchParams.delete('media_taxonomies_bulk');
            url.searchParams.delete('media_ids');
            url.searchParams.set('media_taxonomies_updated', String(count));
            window.location.href = url.toString();
          }, 600);
          return;
        }

        exitBulkSelectMode();
        closeBulkPanel();
      })
      .catch(function () {
        $status.text(labels.bulkError || 'Could not update taxonomies.');
      });
  }

  /* ------------------------------------------------------------------ */
  /* Grid / modal: patch AttachmentsBrowser                             */
  /* ------------------------------------------------------------------ */

  var MediaCategoryFilter = null;
  var AssignCategoriesButton = null;
  var boundClearFilters = false;

  function resetCategoryFilterView(view) {
    if (!view) {
      return;
    }
    view.filterMode = 'in';
    view.selected = [];
    if (view.options && view.options.$input && view.options.$input.length) {
      view.options.$input.val('');
    }
    if (view.$el && view.$el.length && view.$('.media-categories-filter-toggle').length) {
      view.syncPanelState();
      view.updateToggleLabel();
      if (typeof view.closePanel === 'function') {
        view.closePanel();
      }
    }
    if (view.live && typeof view.applyFilter === 'function') {
      view.applyFilter();
    }
  }

  function resetAllCategoryFilterViews() {
    categoryFilterViews.forEach(resetCategoryFilterView);
    $('.media-taxonomies-filter-select').val('').attr('data-encoded', '');
    $('[id^="media-taxonomies-filter-value-"]').val('');
  }

  function bindClearFilters() {
    if (boundClearFilters) {
      return;
    }
    if (window.cloakwpMediaLibrary && typeof cloakwpMediaLibrary.onClear === 'function') {
      cloakwpMediaLibrary.onClear(function () {
        resetAllCategoryFilterViews();
      });
      boundClearFilters = true;
      return;
    }
    $(document).on('cloakwp.mediaLibrary.clearFilters', function () {
      resetAllCategoryFilterViews();
    });
    boundClearFilters = true;
  }

  function ensureMediaViews() {
    if (MediaCategoryFilter) {
      return true;
    }
    if (!window.wp || !wp.media || !wp.media.view || !wp.media.View) {
      return false;
    }

    MediaCategoryFilter = wp.media.View.extend({
      tagName: 'div',
      className: 'media-categories-filter-wrap',

      events: {
        'click .media-categories-filter-toggle': 'onToggle',
        'click .media-categories-filter-mode-btn': 'onMode',
        'click .media-categories-filter-clear': 'onClear',
        'change .media-categories-filter-term': 'onTermChange',
      },

      initialize: function () {
        this.tax = this.options.tax || taxonomies[0] || { slug: '', terms: [], labels: {}, filterArg: '' };
        this.taxSlug = this.tax.slug;
        this.taxLabels = taxLabels(this.tax);
        this.listArg = this.tax.filterArg || 'filter_' + this.taxSlug;
        this.live = this.options.live !== false;
        this.panelOpen = false;
        this.filterMode = 'in';
        this.selected = [];
        this.toggleId =
          this.options.toggleId ||
          'media-categories-attachment-filter-' + this.taxSlug + '-' + this.cid;
        this.syncFromModel();
        if (this.model && typeof this.model.on === 'function' && this.taxSlug) {
          this.model.on('change:' + this.taxSlug, this.syncFromModel, this);
        }
      },

      syncFromModel: function () {
        var encoded = '';
        if (this.options.encoded != null && this.options.encoded !== '') {
          encoded = this.options.encoded;
          this.options.encoded = null;
        } else if (this.model && typeof this.model.get === 'function') {
          encoded = this.model.get(this.taxSlug) || '';
        }
        var parsed = parseFilterValue(encoded);
        this.filterMode = parsed.mode;
        this.selected = parsed.selected;
        if (this.$el && this.$el.length && this.$('.media-categories-filter-toggle').length) {
          this.syncPanelState();
          this.updateToggleLabel();
        }
      },

      termRowsHtml: function () {
        return ((this.tax && this.tax.terms) || [])
          .map(function (term) {
            var text = termPrefix(term.depth) + term.name + ' (' + term.count + ')';
            return (
              '<label class="media-categories-filter-row">' +
              '<input type="checkbox" class="media-categories-filter-term" value="' +
              term.id +
              '" /> ' +
              '<span>' +
              $('<div>').text(text).html() +
              '</span></label>'
            );
          })
          .join('');
      },

      render: function () {
        var panelId = 'media-categories-filter-panel-' + this.cid;
        var toggleId = this.toggleId;
        var filterBy = this.taxLabels.filterBy || labels.filterBy || 'Filter by Media Category';

        this.$el.attr('data-taxonomy', this.taxSlug);
        this.$el.html(
          '<button type="button" class="media-categories-filter-toggle" id="' +
            toggleId +
            '" aria-expanded="false" aria-controls="' +
            panelId +
            '" aria-haspopup="true">' +
            '</button>' +
            '<div class="media-categories-filter-panel hidden" id="' +
            panelId +
            '" role="dialog" aria-label="' +
            $('<div>').text(filterBy).html() +
            '">' +
            '<div class="media-categories-filter-mode" role="group" aria-label="' +
            $('<div>').text(filterBy).html() +
            '">' +
            '<button type="button" class="button media-categories-filter-mode-btn" data-mode="in">' +
            $('<div>').text(this.taxLabels.include || labels.include || 'In').html() +
            '</button>' +
            '<button type="button" class="button media-categories-filter-mode-btn" data-mode="not">' +
            $('<div>').text(this.taxLabels.exclude || labels.exclude || 'Not in').html() +
            '</button>' +
            '</div>' +
            '<button type="button" class="button-link media-categories-filter-clear">' +
            $('<div>').text(this.taxLabels.all || labels.all || 'All').html() +
            '</button>' +
            '<label class="media-categories-filter-row">' +
            '<input type="checkbox" class="media-categories-filter-term" value="' +
            uncategorized +
            '" /> ' +
            '<span>' +
            $('<div>').text(this.taxLabels.uncategorized || 'Uncategorized').html() +
            '</span></label>' +
            '<div class="media-categories-filter-terms" data-taxonomy="' +
            this.taxSlug +
            '">' +
            this.termRowsHtml() +
            '</div></div>'
        );

        this.syncPanelState();
        this.updateToggleLabel();
        return this;
      },

      syncPanelState: function () {
        var self = this;
        var selected = this.selected.map(String);
        this.$('.media-categories-filter-term').each(function () {
          this.checked = selected.indexOf(String(this.value)) !== -1;
        });
        this.$('.media-categories-filter-mode-btn').each(function () {
          var on = this.getAttribute('data-mode') === self.filterMode;
          this.setAttribute('aria-pressed', on ? 'true' : 'false');
          $(this).toggleClass('button-primary', on);
        });
      },

      updateToggleLabel: function () {
        var text = this.taxLabels.all || labels.all || 'All';
        var selected = this.selected;
        var terms = (this.tax && this.tax.terms) || [];
        if (selected.length === 1 && selected[0] === uncategorized) {
          text =
            this.filterMode === 'not'
              ? this.taxLabels.categorized || 'Categorized'
              : this.taxLabels.uncategorized || 'Uncategorized';
        } else if (selected.length === 1) {
          var term = terms.filter(function (item) {
            return item.id === selected[0];
          })[0];
          text = term ? term.name : String(selected[0]);
          if (this.filterMode === 'not') {
            text = (this.taxLabels.exclude || 'Not in') + ' ' + text;
          }
        } else if (selected.length > 1) {
          var countLabel = (this.taxLabels.selectedCount || labels.selectedCount || '%d selected').replace(
            '%d',
            String(selected.length)
          );
          text =
            this.filterMode === 'not'
              ? (this.taxLabels.exclude || 'Not in') + ' · ' + countLabel
              : countLabel;
        }
        this.$('.media-categories-filter-toggle')
          .text(text)
          .toggleClass('cloakwp-media-library-filter-active', selected.length > 0);
      },

      collectSelected: function () {
        return this.$('.media-categories-filter-term:checked')
          .map(function () {
            return this.value === uncategorized ? uncategorized : parseInt(this.value, 10);
          })
          .get();
      },

      applyFilter: function () {
        var encoded = encodeFilterValue(this.filterMode, this.selected);
        this.updateToggleLabel();
        if (this.options.$input && this.options.$input.length) {
          this.options.$input.val(encoded);
        }
        if (!this.live || !this.model) {
          return;
        }
        var listArg = this.listArg;
        var slug = this.taxSlug;
        if (!encoded) {
          if (typeof this.model.unset === 'function') {
            this.model.unset(slug);
            if (listArg && listArg !== slug) {
              this.model.unset(listArg, { silent: true });
            }
          }
          return;
        }
        if (typeof this.model.set !== 'function') {
          return;
        }
        var props = {};
        props[slug] = encoded;
        var currentType = this.model.get('type');
        if (currentType) {
          props.type = currentType;
        }
        this.model.set(props);
      },

      onToggle: function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (this.panelOpen) {
          this.closePanel();
        } else {
          this.openPanel();
        }
      },

      onMode: function (e) {
        e.preventDefault();
        this.filterMode = $(e.currentTarget).attr('data-mode') === 'not' ? 'not' : 'in';
        this.syncPanelState();
        if (this.selected.length) {
          this.applyFilter();
        } else {
          this.updateToggleLabel();
        }
      },

      onClear: function (e) {
        e.preventDefault();
        this.selected = [];
        this.syncPanelState();
        this.applyFilter();
      },

      onTermChange: function (e) {
        var $input = $(e.currentTarget);
        var value = $input.val();
        if ($input.prop('checked') && value === uncategorized) {
          this.$('.media-categories-filter-term')
            .not($input)
            .prop('checked', false);
        } else if ($input.prop('checked')) {
          this.$('.media-categories-filter-term[value="' + uncategorized + '"]').prop(
            'checked',
            false
          );
        }
        this.selected = this.collectSelected();
        this.applyFilter();
      },

      openPanel: function () {
        if (openFilterView && openFilterView !== this) {
          openFilterView.closePanel();
        }
        bindFilterDocumentEvents();
        this.panelOpen = true;
        openFilterView = this;
        this.$('.media-categories-filter-panel').removeClass('hidden');
        this.$('.media-categories-filter-toggle').attr('aria-expanded', 'true');
        this.positionPanel();
        $(window).on(
          'resize.mediaCategoriesFilter-' + this.cid,
          $.proxy(this.positionPanel, this)
        );
      },

      closePanel: function () {
        this.panelOpen = false;
        if (openFilterView === this) {
          openFilterView = null;
        }
        this.$('.media-categories-filter-panel').addClass('hidden');
        this.$('.media-categories-filter-toggle').attr('aria-expanded', 'false');
        $(window).off('resize.mediaCategoriesFilter-' + this.cid);
      },

      positionPanel: function () {
        var $panel = this.$('.media-categories-filter-panel');
        var toggle = this.$('.media-categories-filter-toggle').get(0);
        if (!$panel.length || !toggle) {
          return;
        }
        var rect = toggle.getBoundingClientRect();
        var gutter = 8;
        var width = $panel.outerWidth() || 240;
        var left = rect.left;
        if (left + width > window.innerWidth - gutter) {
          left = Math.max(gutter, window.innerWidth - width - gutter);
        }
        $panel.css({
          top: Math.round(rect.bottom + 4),
          left: Math.round(left),
        });
      },
    });

    var Button = wp.media.view.Button;

    AssignCategoriesButton = Button.extend({
      className: 'button media-button assign-categories-button hidden',
      defaults: {
        text: labels.bulkEdit || 'Edit media taxonomies',
        style: 'secondary',
        size: 'large',
        disabled: true,
      },

      initialize: function () {
        Button.prototype.initialize.apply(this, arguments);
        this.controller.on('selection:toggle', this.toggleDisabled, this);
        this.controller.on('select:activate', this.show, this);
        this.controller.on('select:deactivate', this.hide, this);
      },

      toggleDisabled: function () {
        var selection = this.controller.state().get('selection');
        this.model.set('disabled', !selection || !selection.length);
      },

      show: function () {
        this.$el.removeClass('hidden');
        this.toggleDisabled();
      },

      hide: function () {
        this.$el.addClass('hidden');
        closeBulkPanel();
      },

      click: function () {
        if (this.model.get('disabled')) {
          return;
        }
        var selection = this.controller.state().get('selection');
        var ids = selection.map(function (model) {
          return model.id;
        });
        openBulkPanel(ids, this.$el, this.controller);
      },

      render: function () {
        Button.prototype.render.apply(this, arguments);
        // Grid bulk-select only — picker modals (ACF Image, Add Media) are
        // already "select" frames and use the attachment sidebar instead.
        if (
          this.controller.isModeActive('grid') &&
          this.controller.isModeActive('select')
        ) {
          this.$el.removeClass('hidden');
        } else {
          this.$el.addClass('hidden');
        }
        this.toggleDisabled();
        return this;
      },
    });

    return true;
  }

  /**
   * Add the category dropdown to an AttachmentsBrowser toolbar.
   * Used from createToolbar and again when ACF activates its browse state
   * (ACF builds a fresh Select frame per Image/Gallery/File click).
   */
  function injectCategoryFilter(browser) {
    if (!ensureMediaViews() || !browser || !browser.toolbar || !browser.collection) {
      return;
    }
    if (!taxonomies.length) {
      return;
    }
    if (browser.toolbar.get('MediaTaxonomyFilter-' + taxonomies[0].slug)) {
      return;
    }

    taxonomies.forEach(function (tax, index) {
      var priority = -74 + index;
      var filterView = new MediaCategoryFilter({
        tax: tax,
        controller: browser.controller,
        model: browser.collection.props,
        live: true,
        priority: priority,
      }).render();

      if (wp.media.view.Label) {
        browser.toolbar.set(
          'MediaTaxonomyFilterLabel-' + tax.slug,
          new wp.media.view.Label({
            value: taxLabels(tax).filterBy || 'Filter by ' + (taxLabels(tax).singular || tax.slug),
            attributes: {
              'for': filterView.toggleId,
            },
            priority: priority,
          }).render()
        );
      }

      browser.toolbar.set('MediaTaxonomyFilter-' + tax.slug, filterView);
      categoryFilterViews.push(filterView);
    });

    if (
      settings.assignCap &&
      AssignCategoriesButton &&
      !browser.toolbar.get('AssignCategoriesButton') &&
      browser.controller &&
      typeof browser.controller.isModeActive === 'function' &&
      browser.controller.isModeActive('grid')
    ) {
      browser.toolbar.set(
        'AssignCategoriesButton',
        new AssignCategoriesButton({
          controller: browser.controller,
          priority: -60,
        }).render()
      );
    }
  }

  var boundLibraryToolbar = false;

  function bindLibraryToolbar() {
    if (boundLibraryToolbar) {
      if (window.cloakwpMediaLibrary && typeof cloakwpMediaLibrary.patch === 'function') {
        cloakwpMediaLibrary.patch();
      }
      return true;
    }
    if (window.cloakwpMediaLibrary && typeof cloakwpMediaLibrary.onToolbar === 'function') {
      cloakwpMediaLibrary.onToolbar(injectCategoryFilter);
      boundLibraryToolbar = true;
      bindClearFilters();
      if (typeof cloakwpMediaLibrary.patch === 'function') {
        cloakwpMediaLibrary.patch();
      }
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Attachment sidebar: REST replace + Add New category                */
  /* ------------------------------------------------------------------ */

  function escapeHtml(text) {
    return $('<div>').text(text == null ? '' : String(text)).html();
  }

  function termDepthFromSettings(term, tax) {
    var depth = 0;
    var parent = parseInt(term.parent, 10) || 0;
    var byId = {};
    ((tax && tax.terms) || []).forEach(function (item) {
      byId[parseInt(item.id, 10)] = item;
    });
    var guard = 0;
    while (parent > 0 && byId[parent] && guard++ < 50) {
      depth += 1;
      parent = parseInt(byId[parent].parent, 10) || 0;
    }
    return depth;
  }

  function registerCreatedTerm(term, taxSlug) {
    var tax = taxBySlug(taxSlug);
    if (!tax) {
      return null;
    }
    tax.terms = tax.terms || [];
    var id = parseInt(term.id, 10);
    var existing = tax.terms.filter(function (item) {
      return parseInt(item.id, 10) === id;
    })[0];
    if (existing) {
      return existing;
    }
    var row = {
      id: id,
      name: decodeHtmlEntities(term.name),
      slug: term.slug,
      parent: parseInt(term.parent, 10) || 0,
      count: parseInt(term.count, 10) || 0,
    };
    row.depth = termDepthFromSettings(row, tax);
    tax.terms.push(row);
    return row;
  }

  function appendTermToChecklist($checklist, term, checked, taxSlug) {
    if (!$checklist || !$checklist.length) {
      return;
    }
    if ($checklist.find('input[type="checkbox"][value="' + term.id + '"]').length) {
      return;
    }
    var slug = taxSlug || $checklist.closest('.media-categories-attachment-field').attr('data-taxonomy') || '';
    var $li = $(
      '<li id="' +
        slug +
        '-' +
        term.id +
        '">' +
        '<label class="selectit">' +
        '<input value="' +
        term.id +
        '" type="checkbox" name="tax_input[' +
        slug +
        '][]" data-slug="' +
        escapeHtml(term.slug || '') +
        '"' +
        (checked ? ' checked="checked"' : '') +
        ' /> ' +
        escapeHtml(term.name) +
        '</label></li>'
    );
    var parentId = parseInt(term.parent, 10) || 0;
    var $parentLi =
      parentId > 0
        ? $checklist
            .find('input[type="checkbox"][value="' + parentId + '"]')
            .closest('li')
            .first()
        : $();
    if ($parentLi.length) {
      var $kids = $parentLi.children('ul.children');
      if (!$kids.length) {
        $kids = $('<ul class="children"></ul>');
        $parentLi.append($kids);
      }
      $kids.append($li);
    } else {
      $checklist.append($li);
    }
  }

  function appendTermToParentSelect($select, term, tax) {
    if (!$select || !$select.length) {
      return;
    }
    if ($select.find('option[value="' + term.id + '"]').length) {
      return;
    }
    var depth = term.depth != null ? term.depth : termDepthFromSettings(term, tax);
    var pad = new Array(depth * 3 + 1).join('\u00a0');
    var $option = $('<option></option>').val(String(term.id)).text(pad + term.name);
    var parentId = parseInt(term.parent, 10) || 0;
    if (parentId > 0) {
      var $parentOpt = $select.find('option[value="' + parentId + '"]');
      if ($parentOpt.length) {
        $parentOpt.after($option);
        return;
      }
    }
    $select.append($option);
  }

  function syncSidebarField($field) {
    if (!$field || !$field.length) {
      return;
    }
    var tax = taxBySlug($field.attr('data-taxonomy'));
    if (!tax) {
      return;
    }
    var $checklist = $field.find('.media-categories-checklist');
    var $parent = $field.find('.media-categories-new-parent');
    (tax.terms || []).forEach(function (term) {
      appendTermToChecklist($checklist, term, false, tax.slug);
      appendTermToParentSelect($parent, term, tax);
    });
  }

  function addTermToFilterPanels(term, taxSlug) {
    $('.media-categories-filter-terms[data-taxonomy="' + taxSlug + '"]').each(function () {
      var $box = $(this);
      if ($box.find('.media-categories-filter-term[value="' + term.id + '"]').length) {
        return;
      }
      var text = termPrefix(term.depth) + term.name + ' (' + (term.count || 0) + ')';
      $box.append(
        '<label class="media-categories-filter-row">' +
          '<input type="checkbox" class="media-categories-filter-term" value="' +
          term.id +
          '" /> <span>' +
          escapeHtml(text) +
          '</span></label>'
      );
    });
  }

  function addTermToBulkPanel(term, taxSlug) {
    if (!$bulkPanel) {
      return;
    }
    var $box = $bulkPanel.find('.media-categories-bulk-terms');
    if ($box.find('input[value="' + term.id + '"][data-taxonomy="' + taxSlug + '"]').length) {
      return;
    }
    $box.append(
      '<label class="media-categories-bulk-term">' +
        '<input type="checkbox" value="' +
        term.id +
        '" data-taxonomy="' +
        taxSlug +
        '" /> ' +
        escapeHtml(termPrefix(term.depth) + term.name) +
        '</label>'
    );
  }

  function rememberCreatedTerm(term, $currentField) {
    var taxSlug = $currentField && $currentField.length ? $currentField.attr('data-taxonomy') : '';
    var row = registerCreatedTerm(term, taxSlug);
    if (!row) {
      return null;
    }
    if ($currentField && $currentField.length) {
      appendTermToChecklist($currentField.find('.media-categories-checklist'), row, true, taxSlug);
      appendTermToParentSelect(
        $currentField.find('.media-categories-new-parent'),
        row,
        taxBySlug(taxSlug)
      );
    }
    $('.media-categories-attachment-field').each(function () {
      if ($currentField && this === $currentField.get(0)) {
        return;
      }
      if ($(this).attr('data-taxonomy') !== taxSlug) {
        return;
      }
      syncSidebarField($(this));
    });
    addTermToFilterPanels(row, taxSlug);
    addTermToBulkPanel(row, taxSlug);
    return row;
  }

  function collectCheckedTermIds($field) {
    return $field
      .find('.media-categories-checklist input[type="checkbox"]:checked')
      .map(function () {
        return parseInt(this.value, 10);
      })
      .get()
      .filter(function (id) {
        return id > 0;
      });
  }

  function refreshAttachmentModel(attachmentId) {
    if (!window.wp || !wp.media || !wp.media.model || !wp.media.model.Attachment) {
      return;
    }
    var model = wp.media.model.Attachment.get(attachmentId);
    if (model && typeof model.fetch === 'function') {
      model.fetch();
    }
  }

  function saveAttachmentCategories(attachmentId, $field, onDone) {
    if (!attachmentId || !settings.restUrl) {
      if (onDone) {
        onDone();
      }
      return;
    }

    fetch(settings.restUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WP-Nonce': settings.nonce,
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        attachment_ids: [attachmentId],
        taxonomy: $field.attr('data-taxonomy') || '',
        term_ids: collectCheckedTermIds($field),
        append: false,
        replace: true,
      }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          window.alert(
            (result.data && result.data.message) ||
              labels.bulkError ||
              'Could not update taxonomies.'
          );
          return;
        }
        refreshAttachmentModel(attachmentId);
      })
      .catch(function () {
        window.alert(labels.bulkError || 'Could not update taxonomies.');
      })
      .finally(function () {
        if (onDone) {
          onDone();
        }
      });
  }

  function patchTwoColumnSidebarSync() {
    var Details =
      window.wp && wp.media && wp.media.view && wp.media.view.Attachment
        ? wp.media.view.Attachment.Details
        : null;
    var TwoColumn = Details && Details.TwoColumn ? Details.TwoColumn.prototype : null;
    if (!TwoColumn || TwoColumn._mediaCategoriesPatched) {
      return;
    }
    var originalTwoColumnRender = TwoColumn.render;
    TwoColumn.render = function () {
      var result = originalTwoColumnRender.apply(this, arguments);
      syncSidebarField(this.$('.media-categories-attachment-field'));
      return result;
    };
    TwoColumn._mediaCategoriesPatched = true;
  }

  function patchAttachmentCompatSave() {
    if (!window.wp || !wp.media || !wp.media.view || !wp.media.view.AttachmentCompat) {
      return false;
    }
    if (!wp.media.view.AttachmentCompat.prototype._mediaCategoriesPatched) {
      var originalSave = wp.media.view.AttachmentCompat.prototype.save;
      wp.media.view.AttachmentCompat.prototype.save = function (event) {
        if (
          event &&
          event.target &&
          event.target.closest &&
          event.target.closest('.media-categories-attachment-field')
        ) {
          // Let the document REST handler persist IDs. Do not POST to
          // save-attachment-compat (core would treat taxonomy values as slugs).
          event.preventDefault();
          return;
        }
        return originalSave.apply(this, arguments);
      };

      // query-attachments caches compat.item per model. Next/prev re-renders
      // that snapshot, which would omit terms created in this session.
      var originalRender = wp.media.view.AttachmentCompat.prototype.render;
      wp.media.view.AttachmentCompat.prototype.render = function () {
        var result = originalRender.apply(this, arguments);
        syncSidebarField(this.$('.media-categories-attachment-field'));
        return result;
      };

      wp.media.view.AttachmentCompat.prototype._mediaCategoriesPatched = true;
    }

    patchTwoColumnSidebarSync();
    return true;
  }

  function setAddFormVisible($wrap, visible) {
    var $btn = $wrap.find('.media-categories-add-toggle');
    var $form = $wrap.find('.media-categories-add-form');
    $btn.attr('aria-expanded', visible ? 'true' : 'false');
    $form.toggleClass('hidden', !visible);
    $btn.text(
      visible
        ? $btn.attr('data-label-cancel') || labels.cancel || 'Cancel'
        : $btn.attr('data-label-add') || labels.addNew || 'Add New Media Category'
    );
  }

  function initAddNewHandlers() {
    $(document).on(
      'change',
      '.media-categories-checklist input[type="checkbox"]',
      function () {
        var $field = $(this).closest('.media-categories-attachment-field');
        var attachmentId = parseInt($field.attr('data-attachment-id'), 10);
        var frame =
          (window.wp && wp.media && (wp.media.frame || (wp.media.frames && wp.media.frames.edit))) ||
          null;
        if (frame && typeof frame.trigger === 'function') {
          frame.trigger('attachment:compat:waiting', ['waiting']);
        }
        saveAttachmentCategories(attachmentId, $field, function () {
          if (frame && typeof frame.trigger === 'function') {
            frame.trigger('attachment:compat:ready', ['ready']);
          }
        });
      }
    );

    $(document).on('click', '.media-categories-add-toggle', function (e) {
      e.preventDefault();
      var $wrap = $(this).closest('.media-categories-add-new');
      setAddFormVisible($wrap, $(this).attr('aria-expanded') !== 'true');
    });

    $(document).on('click', '.edit-media-header .left, .edit-media-header .right', function () {
      window.setTimeout(function () {
        $('.media-categories-attachment-field').each(function () {
          syncSidebarField($(this));
        });
      }, 0);
    });

    $(document).on('click', '.media-categories-add-submit', function (e) {
      e.preventDefault();
      if (!settings.manageCap || !window.wp || !wp.apiFetch) {
        return;
      }

      var $wrap = $(this).closest('.media-categories-add-new');
      var $field = $wrap.closest('.media-categories-attachment-field');
      var $name = $wrap.find('.media-categories-new-name');
      var $parent = $wrap.find('.media-categories-new-parent');
      var name = $.trim($name.val() || '');
      if (!name) {
        $name.trigger('focus');
        return;
      }

      var data = { name: name };
      var parent = parseInt($parent.val(), 10);
      if (parent > 0) {
        data.parent = parent;
      }

      var taxSlug = $field.attr('data-taxonomy') || '';
      var tax = taxBySlug(taxSlug);
      var restBase = (tax && tax.restBase) || taxSlug;
      if (!restBase) {
        return;
      }

      var $button = $(this);
      $button.prop('disabled', true);

      wp
        .apiFetch({
          path: '/wp/v2/' + restBase,
          method: 'POST',
          data: data,
        })
        .then(function (term) {
          rememberCreatedTerm(term, $field);
          $name.val('');
          setAddFormVisible($wrap, false);

          var attachmentId = parseInt($field.attr('data-attachment-id'), 10);
          saveAttachmentCategories(attachmentId, $field);
        })
        .catch(function () {
          window.alert(labels.bulkError || 'Could not create term.');
        })
        .finally(function () {
          $button.prop('disabled', false);
        });
    });
  }

  function initListBulkFromQuery() {
    var ids = window.mediaTaxonomiesBulkIds || null;
    if (!ids || !ids.length) {
      var params = new URLSearchParams(window.location.search);
      if (params.get('media_taxonomies_bulk') === '1') {
        ids = (params.get('media_ids') || '')
          .split(',')
          .map(function (id) {
            return parseInt(id, 10);
          })
          .filter(Boolean);
      }
    }
    if (!ids || !ids.length) {
      return;
    }
    openBulkPanel(ids, $('#posts-filter .bulkactions').first());
  }

  function enhanceListFilter() {
    $('.media-taxonomies-filter-select').each(function () {
      var $select = $(this);
      if ($select.data('mediaCategoriesEnhanced')) {
        return;
      }
      if (!window.Backbone || !Backbone.Model || !ensureMediaViews() || !MediaCategoryFilter) {
        return;
      }
      var tax = taxBySlug($select.attr('data-taxonomy'));
      if (!tax) {
        return;
      }
      $select.data('mediaCategoriesEnhanced', true);

      var encoded = $select.attr('data-encoded') || $select.val() || '';
      var parsed = parseFilterValue(encoded);
      var $not = $('#media-taxonomies-filter-not-' + tax.slug);
      if ($not.is(':checked') && parsed.mode === 'in' && parsed.selected.length) {
        parsed.mode = 'not';
      }
      encoded = encodeFilterValue(parsed.mode, parsed.selected);

      var $hidden = $('<input type="hidden" />')
        .attr({
          name: $select.attr('name'),
          id: 'media-taxonomies-filter-value-' + tax.slug,
        })
        .val(encoded);
      $select.removeAttr('name');

      var model = new Backbone.Model();
      model.set(tax.slug, encoded);

      var view = new MediaCategoryFilter({
        tax: tax,
        model: model,
        live: false,
        $input: $hidden,
        encoded: encoded,
        toggleId: 'media-taxonomies-filter-toggle-' + tax.slug,
      });
      view.render();

      $select.hide().after($hidden).after(view.$el);
      categoryFilterViews.push(view);
      bindClearFilters();
      $select.nextAll('.media-categories-filter-not-wrap').first().hide();
      $('label[for="media-taxonomies-filter-' + tax.slug + '"]').attr(
        'for',
        'media-taxonomies-filter-toggle-' + tax.slug
      );

      $select.closest('form').on('submit.mediaCategoriesFilter-' + tax.slug, function () {
        $hidden.val(encodeFilterValue(view.filterMode, view.selected));
        $not.prop('checked', false);
      });
    });
  }

  // Register with the shared LibraryFilter toolbar as soon as it exists.
  if (!bindLibraryToolbar()) {
    $(function () {
      bindLibraryToolbar();
    });
  }
  if (!patchAttachmentCompatSave()) {
    $(function () {
      patchAttachmentCompatSave();
    });
  }

  $(function () {
    initAddNewHandlers();
    initListBulkFromQuery();
    // One more attempt after other footer scripts (media-grid, acf-input) have run.
    bindLibraryToolbar();
    bindClearFilters();
    enhanceListFilter();
    patchAttachmentCompatSave();
  });
})(window, jQuery);
