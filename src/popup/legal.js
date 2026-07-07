(function () {
  'use strict';
  function activate(name) {
    var tabs = document.querySelectorAll('.tab');
    var panels = document.querySelectorAll('.panel');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
    }
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle('active', panels[j].id === 'panel-' + name);
    }
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('.tab') : null;
    if (t) activate(t.getAttribute('data-tab'));
  });
  // 深链：?tab=disclaimer|refund|faq
  try {
    var q = new URLSearchParams(window.location.search).get('tab');
    if (q && document.getElementById('panel-' + q)) activate(q);
  } catch (e) {}
})();
