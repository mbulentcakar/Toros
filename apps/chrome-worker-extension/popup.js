const tabLabel = document.querySelector('#tab');
const pairing = document.querySelector('#pairing');
const connected = document.querySelector('#connected');
const message = document.querySelector('#message');
const pairButton = document.querySelector('#pair');
const selectButton = document.querySelector('#select');
const refreshButton = document.querySelector('#refresh');
const nodeUrl = document.querySelector('#node-url');
const code = document.querySelector('#code');
let activeTab = null;

function show(text, error = false) {
  message.textContent = text;
  message.className = error ? 'error' : 'success';
}

async function active() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!Number.isInteger(tab?.id) || typeof tab.url !== 'string' || !tab.url.startsWith('https://')) return null;
  return tab;
}

async function grant(tab) {
  const origin = new URL(tab.url).origin;
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) throw new Error(`Chrome did not grant ${origin}.`);
}

async function load() {
  activeTab = await active();
  tabLabel.textContent = activeTab ? `${activeTab.title || 'Current tab'}\n${new URL(activeTab.url).origin}` : 'Open an HTTPS webpage before pairing.';
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  pairing.hidden = Boolean(status?.paired);
  connected.hidden = !status?.paired;
  if (status?.node_url) nodeUrl.value = status.node_url;
}

pairButton.addEventListener('click', () => {
  void (async () => {
    pairButton.disabled = true;
    if (!activeTab) throw new Error('Open the target HTTPS webpage first.');
    if (!/^\d{8}$/.test(code.value.trim())) throw new Error('Enter the 8-digit code shown in Toros Cockpit.');
    await grant(activeTab);
    const result = await chrome.runtime.sendMessage({ type: 'pair', node_url: nodeUrl.value.trim(), code: code.value.trim(), tab_id: activeTab.id });
    if (!result?.ok) throw new Error(result?.error ?? 'Pairing failed.');
    show('Paired. Toros can now use this tab.');
    await load();
  })().catch((error) => show(error instanceof Error ? error.message : String(error), true)).finally(() => { pairButton.disabled = false; });
});

selectButton.addEventListener('click', () => {
  void (async () => {
    if (!activeTab) throw new Error('Open the target HTTPS webpage first.');
    await grant(activeTab);
    const result = await chrome.runtime.sendMessage({ type: 'select_tab', tab_id: activeTab.id });
    if (!result?.ok) throw new Error(result?.error ?? 'Could not select this tab.');
    show('This tab is now attached to Toros.');
  })().catch((error) => show(error instanceof Error ? error.message : String(error), true));
});

refreshButton.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'poll' }).then(() => show('Checked for work.')).catch((error) => show(String(error), true));
});

void load().catch((error) => show(error instanceof Error ? error.message : String(error), true));
