(function () {
  'use strict';

  // ── 下载地址占位 ──
  // ⚠️ user 自建下载网页上线后，把下面这一行替换为真实下载地址（别填 Edge/Releases）。
  var UPDATE_URL = 'https://TODO-自建网页';

  var isPlaceholder = UPDATE_URL.indexOf('TODO') !== -1;

  var btn = document.getElementById('dlBtn');
  if (btn) {
    if (isPlaceholder) {
      // 占位状态：不跳转，点一下提示链接待填
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        alert('下载链接待填——自建下载页上线后即可一键下载。\n暂请联系产品负责人获取最新安装包：微信 13631515693');
      });
    } else {
      btn.setAttribute('href', UPDATE_URL);
    }
  }
})();
