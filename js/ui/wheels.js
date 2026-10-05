/*
 * Historical Board — four numbered wheels and the +/− wheel, exactly as on the physical board.
 * Only the wheels the current Trial uses are shown, and they only take legal values.
 */
(function (root) {
  'use strict';
  var TC = root.TC;
  var R = TC.Rules;
  var SYMBOLS = ['●', '▲', '■', '★'];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function caption(type, value, i, cards) {
    if (type === 'T4' || type === 'BET') return R.spaceRangeLabel(value);
    if (type === 'COMB') return value === 1 ? 'เก่าสุด' : value === 4 ? 'ใหม่สุด' : 'ลำดับ ' + value;
    return '';
  }

  function label(type, i, cards) {
    if (type === 'T4' || type === 'COMB') return SYMBOLS[i] + ' ' + cards[i].title;
    if (type === 'BET') return 'วงล้อ ' + (i + 1);
    var units = ['พัน', 'ร้อย', 'สิบ', 'หน่วย'];
    return 'หลัก' + units[i];
  }

  /**
   * @param host     element to render into
   * @param type     Trial id
   * @param cards    public cards on the board (years hidden)
   * @param onLock   function(answer)
   * @param onCancel function()
   */
  function mount(host, type, cards, onLock, onCancel) {
    var spec = R.TRIALS[type];
    var state = { sign: '+', wheels: [] };
    for (var i = 0; i < spec.wheels; i++) state.wheels.push(spec.min);
    var confirming = false;

    function summary() {
      if (type === 'SPLIT') return 'ห่างกัน <b>' + TC.Trials.wheelsToNumber(state.wheels) + '</b> ปี';
      if (type === 'RD') return 'ปี <b>' + (state.sign === '-' ? '−' : '+') + state.wheels.join('') + '</b>';
      return '';
    }

    function render() {
      var html = '<div class="hboard hboard-' + type + '">';
      html += '<div class="wheels">';
      if (spec.sign) {
        html += wheelHTML('sign', state.sign === '+' ? '+' : '−', 'เครื่องหมาย', state.sign === '+' ? 'ค.ศ.' : 'ก่อน ค.ศ.', true);
      }
      state.wheels.forEach(function (v, i) {
        html += wheelHTML(i, v, label(type, i, cards), caption(type, v, i, cards), false);
      });
      html += '</div>';
      var sum = summary();
      if (sum) html += '<div class="hboard-summary">' + sum + '</div>';
      html += '<div class="hboard-actions">' +
        '<button type="button" class="btn ghost" data-act="cancel">ยกเลิก</button>' +
        (confirming
          ? '<button type="button" class="btn primary pulse" data-act="confirm">ยืนยัน ล็อกคำตอบ (แก้ไม่ได้)</button>'
          : '<button type="button" class="btn primary" data-act="lock">ล็อกคำตอบ</button>') +
        '</div></div>';
      host.innerHTML = html;
    }

    function wheelHTML(key, value, title, cap, isSign) {
      return '<div class="wheel' + (isSign ? ' wheel-sign' : '') + '" data-wheel="' + key + '" tabindex="0" ' +
        'role="spinbutton" aria-label="' + esc(title) + '" aria-valuenow="' + esc(value) + '">' +
        '<div class="wheel-title" title="' + esc(title) + '">' + esc(title) + '</div>' +
        '<button type="button" class="wheel-btn" data-step="1" aria-label="เพิ่ม">▲</button>' +
        '<div class="wheel-window"><span>' + esc(value) + '</span></div>' +
        '<button type="button" class="wheel-btn" data-step="-1" aria-label="ลด">▼</button>' +
        '<div class="wheel-cap">' + esc(cap) + '</div></div>';
    }

    function step(key, dir) {
      confirming = false;
      if (key === 'sign') {
        state.sign = state.sign === '+' ? '-' : '+';
      } else {
        var i = Number(key), span = spec.max - spec.min + 1;
        state.wheels[i] = spec.min + ((state.wheels[i] - spec.min + dir + span) % span);
      }
      render();
      var w = host.querySelector('[data-wheel="' + key + '"]');
      if (w) w.focus();
    }

    host.onclick = function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.step) return step(btn.closest('.wheel').dataset.wheel, Number(btn.dataset.step));
      if (btn.dataset.act === 'cancel') return onCancel();
      if (btn.dataset.act === 'lock') { confirming = true; return render(); }
      if (btn.dataset.act === 'confirm') {
        var answer = { wheels: state.wheels.slice() };
        if (spec.sign) answer.sign = state.sign;
        onLock(answer);
      }
    };
    host.onkeydown = function (e) {
      var w = e.target.closest && e.target.closest('.wheel');
      if (!w) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); step(w.dataset.wheel, 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); step(w.dataset.wheel, -1); }
      else if (/^[0-9]$/.test(e.key) && w.dataset.wheel !== 'sign') {
        var v = Number(e.key);
        if (v >= spec.min && v <= spec.max) {
          state.wheels[Number(w.dataset.wheel)] = v; confirming = false; render();
          var next = host.querySelector('[data-wheel="' + (Number(w.dataset.wheel) + 1) + '"]') || host.querySelector('[data-wheel="' + w.dataset.wheel + '"]');
          next.focus();
        }
      } else if ((e.key === '+' || e.key === '-') && w.dataset.wheel === 'sign') {
        state.sign = e.key; confirming = false; render();
        host.querySelector('[data-wheel="sign"]').focus();
      }
    };
    render();
  }

  TC.UI = TC.UI || {};
  TC.UI.Wheels = { mount: mount, SYMBOLS: SYMBOLS, esc: esc };
})(window);
