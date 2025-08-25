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
    if ('IntersectionObserver' in window) {
      // 获取配置中的offset_factor，如果没有则使用默认值2
      var offsetFactor = (CONFIG && CONFIG.lazyload && CONFIG.lazyload.offset_factor) || 2;
      var rootMargin = (window.innerHeight || document.documentElement.clientHeight) * offsetFactor + 'px';
      
      var imageObserver = new IntersectionObserver(function(entries, observer) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            var img = entry.target;
            loadImage(img);
            observer.unobserve(img);
          }
        });
      }, {
        rootMargin: rootMargin
      });

      lazyImages.forEach(function(img) {
        imageObserver.observe(img);
      });
    } else {
      // 降级处理：直接加载所有图片
      lazyImages.forEach(loadImage);
    }
  }

  // 加载单个图片
  function loadImage(img) {
    // 获取实际图片地址
    var src = img.getAttribute('data-src');
    var srcset = img.getAttribute('data-srcset');
    
    // 创建新的图片对象来预加载
    if (src || srcset) {
      var newImg = new Image();
      
      newImg.onload = function() {
        if (src) {
          img.src = src;
        }
        if (srcset) {
          img.srcset = srcset;
        }
        
        img.removeAttribute('lazyload');
        img.classList.add('lazyloaded');
      };
      
      // 如果有错误，也移除lazyload属性避免图片一直不显示
      newImg.onerror = function() {
        img.removeAttribute('lazyload');
        img.classList.add('lazyload-error');
      };
      
      // 设置预加载图片的源
      if (src) {
        newImg.src = src;
      }
      if (srcset) {
        newImg.srcset = srcset;
      }
    } else {
      // 如果没有data-src或data-srcset，直接移除lazyload属性
      img.removeAttribute('lazyload');
      img.classList.add('lazyloaded');
    }
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