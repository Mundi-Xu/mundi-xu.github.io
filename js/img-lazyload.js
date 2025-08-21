/* global Fluid, CONFIG */

(function(window, document) {
  // 预加载关键图片
  function preloadCriticalImages() {
    // 预加载首屏图片
    var criticalImages = document.querySelectorAll('img[critical]');
    for (var i = 0; i < criticalImages.length; i++) {
      var img = criticalImages[i];
      var src = img.getAttribute('data-src') || img.getAttribute('src');
      if (src) {
        var preloadLink = document.createElement('link');
        preloadLink.rel = 'preload';
        preloadLink.as = 'image';
        preloadLink.href = src;
        document.head.appendChild(preloadLink);
      }
    }
  }

  // 图片懒加载优化
  function lazyLoadImages() {
    var lazyImages = document.querySelectorAll('img[lazyload]');
    var imageObserver = new IntersectionObserver(function(entries, observer) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          var img = entry.target;
          // 获取实际图片地址
          var src = img.getAttribute('data-src');
          var srcset = img.getAttribute('data-srcset');
          
          if (src) {
            img.src = src;
          }
          if (srcset) {
            img.srcset = srcset;
          }
          
          img.removeAttribute('lazyload');
          img.classList.add('lazyloaded');
          observer.unobserve(img);
        }
      });
    }, {
      rootMargin: (window.innerHeight || document.documentElement.clientHeight) * (CONFIG.lazyload.offset_factor || 2) + 'px'
    });

    lazyImages.forEach(function(img) {
      imageObserver.observe(img);
    });
  }

  // 初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      preloadCriticalImages();
      lazyLoadImages();
    });
  } else {
    preloadCriticalImages();
    lazyLoadImages();
  }
})(window, document); 