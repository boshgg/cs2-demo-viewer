'use strict';

(() => {
  // Each page reloads its own view from the viewer after a switch, including
  // switches made in another tab. The message contains no filesystem paths.
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('cs2-library-directory') : null;
  function notifyViews() {
    document.dispatchEvent(new Event('library-directory-change'));
  }
  if (channel) channel.onmessage = notifyViews;

  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
    return data;
  }

  function make(tag, text) {
    const item = document.createElement(tag);
    if (text) item.textContent = text;
    return item;
  }

  for (const control of document.querySelectorAll('[data-directory-control]')) {
    const pick = control.querySelector('[data-pick-directory]');
    const edit = control.querySelector('[data-enter-directory]');
    const pathDisplay = document.getElementById(control.dataset.directoryControl);
    const form = make('form');
    form.className = 'directory-path-form';
    form.id = pathDisplay.id + '-form';
    form.hidden = true;
    edit.setAttribute('aria-controls', form.id);
    edit.setAttribute('aria-expanded', 'false');

    const label = make('label', '录像文件夹的完整路径');
    const field = make('input');
    field.type = 'text';
    field.id = pathDisplay.id + '-input';
    field.required = true;
    field.autocomplete = 'off';
    field.spellcheck = false;
    field.placeholder = '例如 D:\\CS2\\比赛录像';
    label.htmlFor = field.id;
    const apply = make('button', '使用此文件夹');
    apply.type = 'submit';
    const cancel = make('button', '取消');
    cancel.type = 'button';
    cancel.className = 'directory-cancel';
    const actions = make('div');
    actions.className = 'directory-form-actions';
    actions.append(apply, cancel);
    form.append(label, field, actions);
    const status = make('p');
    status.setAttribute('role', 'status');
    status.className = 'directory-picker-status';
    control.append(form, status);

    function editor(open) {
      form.hidden = !open;
      edit.setAttribute('aria-expanded', String(open));
      if (open) {
        field.value = pathDisplay.title;
        field.focus();
        field.select();
      }
    }
    function pending(value) {
      for (const button of [pick, edit, apply, cancel]) button.disabled = value;
      field.readOnly = value;
    }
    async function change(nativePicker) {
      if (pick.disabled) return;
      pending(true);
      status.textContent = nativePicker ? '正在打开文件夹选择窗口…' : '正在切换文件夹…';
      let directory = field.value.trim();
      try {
        if (nativePicker) {
          const result = await post('/api/library/directory/pick', {});
          directory = result.directory;
          if (!directory) { status.textContent = ''; return; }
        }
        const result = await post('/api/library/directory', { directory });
        if (!result.directory) throw new Error('未收到新的录像目录，请刷新后重试。');
        pathDisplay.textContent = pathDisplay.title = result.directory;
        editor(false);
        status.textContent = '已切换录像文件夹。';
        notifyViews();
        channel?.postMessage('changed');
      } catch (error) {
        if (nativePicker && form.hidden) {
          editor(true);
          if (directory) field.value = directory;
        }
        status.textContent = error.message;
      } finally {
        pending(false);
        if (!nativePicker && form.hidden) edit.focus();
      }
    }
    pick.addEventListener('click', () => change(true));
    edit.addEventListener('click', () => { status.textContent = ''; editor(form.hidden); });
    cancel.addEventListener('click', () => { status.textContent = ''; editor(false); edit.focus(); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (field.value.trim()) void change(false);
      else { status.textContent = '请填写录像文件夹的完整路径。'; field.focus(); }
    });
  }
})();
