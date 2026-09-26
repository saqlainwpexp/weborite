// Weborite Studio website: feature tabs and carousels. Each part does nothing on pages without it.
// Feature tabs: hover, click or arrow keys switch the pane on the right.
(() => {
  const tabs = [...document.querySelectorAll('.tab')];
  const hover = matchMedia('(hover: hover)').matches;
  const show = (t, focus) => {
    tabs.forEach((x) => {
      const on = x === t;
      x.setAttribute('aria-selected', on);
      x.tabIndex = on ? 0 : -1;
      document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) t.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => show(t));
    if (hover) t.addEventListener('mouseenter', () => show(t));
    t.addEventListener('keydown', (e) => {
      const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); show(tabs[(i + d + tabs.length) % tabs.length], true); }
    });
  });
})();

// Carousels: pill tabs, arrows, swipe, arrow keys; autoplay while on screen, paused on hover or focus.
(() => {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DUR = 5000;
  const arrow = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  document.querySelectorAll('.carousel').forEach((c) => {
    const slides = [...c.querySelectorAll('.car-slide')];
    const track = c.querySelector('.car-track');
    const pill = c.querySelector('.car-pill');
    const title = c.querySelector('.car-title');
    let i = 0, timer = 0, visible = false, held = false;
    c.style.setProperty('--car-dur', DUR + 'ms');

    const mk = (cls, html, label) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.innerHTML = html; if (label) b.setAttribute('aria-label', label); return b; };
    const prev = mk('car-arrow', arrow('m15 18-6-6 6-6'), 'Previous');
    const next = mk('car-arrow', arrow('m9 18 6-6-6-6'), 'Next');
    pill.append(prev);
    const tabs = slides.map((s, k) => {
      const t = mk('car-tab', s.dataset.label);
      t.setAttribute('role', 'tab'); t.setAttribute('aria-label', s.dataset.label);
      t.addEventListener('click', () => go(k));
      t.addEventListener('keydown', (e) => { const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (d) { e.preventDefault(); go(i + d); tabs[i].focus(); } });
      pill.append(t);
      return t;
    });
    pill.append(next);
    prev.addEventListener('click', () => go(i - 1));
    next.addEventListener('click', () => go(i + 1));

    function schedule() {
      clearTimeout(timer);
      c.classList.remove('run');
      void c.offsetWidth; // restart the progress animation
      if (still || !visible || held) return;
      c.classList.add('run');
      timer = setTimeout(() => go(i + 1), DUR);
    }
    function go(n) {
      i = (n + slides.length) % slides.length;
      track.style.transform = `translateX(${-100 * i}%)`;
      slides.forEach((s, k) => { s.setAttribute('aria-hidden', String(k !== i)); if (k === i || k === (i + 1) % slides.length) s.querySelector('img').loading = 'eager'; });
      tabs.forEach((t, k) => { t.setAttribute('aria-selected', String(k === i)); t.tabIndex = k === i ? 0 : -1; });
      if (title) title.textContent = slides[i].dataset.title;
      schedule();
    }
    const hold = (on) => { held = on; c.classList.toggle('paused', on); if (!on) schedule(); else clearTimeout(timer); };
    c.addEventListener('mouseenter', () => hold(true));
    c.addEventListener('mouseleave', () => hold(false));
    c.addEventListener('focusin', () => hold(true));
    c.addEventListener('focusout', (e) => { if (!c.contains(e.relatedTarget)) hold(false); });

    let x0 = null;
    const view = c.querySelector('.car-view');
    view.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
    view.addEventListener('pointerup', (e) => { if (x0 !== null && Math.abs(e.clientX - x0) > 40) go(i + (e.clientX < x0 ? 1 : -1)); x0 = null; });

    new IntersectionObserver(([e]) => { visible = e.isIntersecting; schedule(); }, { threshold: 0.35 }).observe(c);
    new ResizeObserver(() => c.classList.toggle('tight', c.offsetWidth < 640)).observe(c);
    go(0);
  });
})();

// Buy page: keep the summary in step with the plan, check the form, send the order to the license server.
(() => {
  const form = document.getElementById('order-form');
  if (!form) return;
  const PLANS = { monthly: ['Studio · Monthly', '$49', 'per month'], yearly: ['Studio · Yearly', '$490', 'per year, 2 months free'] };
  const want = new URLSearchParams(location.search).get('plan');
  if (want && PLANS[want]) form.querySelector(`input[name=plan][value=${want}]`).checked = true;
  const sync = () => {
    const [name, price, per] = PLANS[form.plan.value];
    document.getElementById('sum-name').textContent = name;
    document.getElementById('sum-price').textContent = price;
    document.getElementById('sum-per').textContent = per;
  };
  form.addEventListener('change', sync);
  sync();

  const err = document.getElementById('order-err');
  const btn = document.getElementById('order-btn');
  const fail = (text, field) => {
    err.textContent = text; err.hidden = false;
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    const el = field && form.elements[field];
    if (el && el.focus) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    data.terms = form.terms.checked;
    if (!data.name.trim()) return fail('Enter your name.', 'name');
    if (!/^\S+@\S+\.\S+$/.test(data.email.trim())) return fail('Enter a valid email address. Your invoice and license key are sent there.', 'email');
    if (!data.terms) return fail('Accept the Terms of Service and Refund Policy to continue.', 'terms');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const res = await fetch('license/order.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) return fail(body.error || "Your order couldn't be sent. Try again, or email hello@weborite.com.", body.field);
      document.getElementById('order-fields').hidden = true;
      const done = document.getElementById('order-done');
      if (body.order) document.getElementById('order-done-text').textContent = `Order #${body.order} is in. We've emailed a confirmation to ${data.email.trim()}. Your invoice follows within one working day, and your license key as soon as the payment arrives.`;
      done.hidden = false; done.focus();
    } catch {
      fail("Your order couldn't be sent. Check your connection and try again, or email hello@weborite.com.");
    } finally {
      btn.disabled = false; btn.textContent = 'Place order';
    }
  });
})();
