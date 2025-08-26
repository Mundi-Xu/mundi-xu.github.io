/* global CONFIG */

(function() {
  // Modified from [hexo-generator-search](https://github.com/wzpan/hexo-generator-search)
  function localSearchFunc(path, searchSelector, resultSelector) {
    'use strict';
    // 0x00. environment initialization
    var $input = jQuery(searchSelector);
    var $result = jQuery(resultSelector);

    if ($input.length === 0) {
      // eslint-disable-next-line no-console
      throw Error('No element selected by the searchSelector');
    }
    if ($result.length === 0) {
      // eslint-disable-next-line no-console
      throw Error('No element selected by the resultSelector');
    }

    if ($result.attr('class').indexOf('list-group-item') === -1) {
      $result.html('<div class="m-auto text-center"><div class="spinner-border" role="status"><span class="sr-only">Loading...</span></div><br/>Loading...</div>');
    }

    // 使用缓存避免重复请求
    if (!window.searchDataCache) {
      window.searchDataCache = {};
    }

    // 如果已缓存则直接使用缓存数据
    if (window.searchDataCache[path]) {
      initSearch(window.searchDataCache[path]);
      return;
    }

    jQuery.ajax({
      // 0x01. load xml file
      url     : path,
      dataType: 'xml',
      success : function(xmlResponse) {
        // 0x02. parse xml file
        var dataList = jQuery('entry', xmlResponse).map(function() {
          return {
            title  : jQuery('title', this).text(),
            content: jQuery('content', this).text(),
            url    : jQuery('url', this).text()
          };
        }).get();

        // 缓存数据
        window.searchDataCache[path] = dataList;
        initSearch(dataList);
      },
      error: function() {
        $result.html('<div class="m-auto text-center">Failed to load search data.</div>');
      }
    });

    function initSearch(dataList) {
      if ($result.html().indexOf('list-group-item') === -1) {
        $result.html('');
      }

      // 使用防抖优化搜索性能
      var searchTimeout;
      $input.on('input', function() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(function() {
          performSearch(dataList);
        }, 300); // 300ms 防抖延迟
      });
    }

    function performSearch(dataList) {
      // 0x03. parse query to keywords list
      var content = $input.val();
      var resultHTML = '';
      var keywords = content.trim().toLowerCase().split(/[\s-]+/);
      $result.html('');
      if (content.trim().length <= 0) {
        return $input.removeClass('invalid').removeClass('valid');
      }
      
      // 限制搜索结果数量以提高性能
      var resultCount = 0;
      var maxResults = 50; // 最多显示50个结果
      
      // 0x04. perform local searching
      for (var i = 0; i < dataList.length && resultCount < maxResults; i++) {
        var data = dataList[i];
        var isMatch = true;
        if (!data.title || data.title.trim() === '') {
          data.title = 'Untitled';
        }
        var orig_data_title = data.title.trim();
        var data_title = orig_data_title.toLowerCase();
        var orig_data_content = data.content.trim().replace(/<[^>]+>/g, '');
        var data_content = orig_data_content.toLowerCase();
        var data_url = data.url;
        var index_title = -1;
        var index_content = -1;
        var first_occur = -1;
        // Skip matching when content is included in search and content is empty
        if (CONFIG.include_content_in_search && data_content === '') {
          isMatch = false;
        } else {
          for (var j = 0; j < keywords.length; j++) {
            var keyword = keywords[j];
            index_title = data_title.indexOf(keyword);
            index_content = data_content.indexOf(keyword);

            if (index_title < 0 && index_content < 0) {
              isMatch = false;
              break;
            } else {
              if (index_content < 0) {
                index_content = 0;
              }
              if (j === 0) {
                first_occur = index_content;
              }
            }
          }
        }
        // 0x05. show search results
        if (isMatch) {
          resultHTML += '<a href=\'' + data_url + '\' class=\'list-group-item list-group-item-action font-weight-bolder search-list-title\'>' + orig_data_title + '</a>';
          var content = orig_data_content;
          if (first_occur >= 0) {
            // cut out 100 characters
            var start = first_occur - 20;
            var end = first_occur + 80;

            if (start < 0) {
              start = 0;
            }

            if (start === 0) {
              end = 100;
            }

            if (end > content.length) {
              end = content.length;
            }

            var match_content = content.substring(start, end);

            // highlight all keywords
            for (var k = 0; k < keywords.length; k++) {
              var keyword = keywords[k];
              var regS = new RegExp(keyword, 'gi');
              match_content = match_content.replace(regS, '<span class="search-word">' + keyword + '</span>');
            }

            resultHTML += '<p class=\'search-list-content\'>' + match_content + '...</p>';
          }
          resultCount++;
        }
      }
      
      if (resultHTML.indexOf('list-group-item') === -1) {
        return $input.addClass('invalid').removeClass('valid');
      }
      $input.addClass('valid').removeClass('invalid');
      $result.html(resultHTML);
    }
  }

  function localSearchReset(searchSelector, resultSelector) {
    'use strict';
    var $input = jQuery(searchSelector);
    var $result = jQuery(resultSelector);

    if ($input.length === 0) {
      // eslint-disable-next-line no-console
      throw Error('No element selected by the searchSelector');
    }
    if ($result.length === 0) {
      // eslint-disable-next-line no-console
      throw Error('No element selected by the resultSelector');
    }

    $input.val('').removeClass('invalid').removeClass('valid');
    $result.html('');
  }

  var modal = jQuery('#modalSearch');
  var searchSelector = '#local-search-input';
  var resultSelector = '#local-search-result';
  modal.on('show.bs.modal', function() {
    var path = CONFIG.search_path || '/local-search.xml';
    localSearchFunc(path, searchSelector, resultSelector);
  });
  modal.on('shown.bs.modal', function() {
    jQuery('#local-search-input').focus();
  });
  modal.on('hidden.bs.modal', function() {
    localSearchReset(searchSelector, resultSelector);
  });
})();
