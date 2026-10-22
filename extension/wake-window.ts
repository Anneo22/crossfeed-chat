// Local, non-web-accessible bootstrap for exact desktop-window ownership and legacy extension code.
// No ticket, credentials or ChatGPT content enters this page.
const bootstrapURL = new URL(location.href);
const markers = bootstrapURL.searchParams.getAll('marker');
if (!bootstrapURL.hash && [...bootstrapURL.searchParams.keys()].length === 1 &&
    markers.length === 1 && /^[a-f0-9]{32}$/.test(markers[0])) {
  document.title = `Crossfeed Wake ${markers[0]}`;
}
