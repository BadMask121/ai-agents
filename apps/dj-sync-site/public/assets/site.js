// The only script on the site: renders the support contact, set in ONE
// place (spec §8). Set to null to hide the contact line again.
const SUPPORT_CONTACT = { label: "jeff.emakpor@gmail.com", href: "mailto:jeff.emakpor@gmail.com?subject=DJ%20Sync%20support" };

if (SUPPORT_CONTACT) {
  for (const el of document.querySelectorAll("[data-support-contact]")) {
    const a = document.createElement("a");
    a.href = SUPPORT_CONTACT.href;
    a.textContent = SUPPORT_CONTACT.label;
    el.append("Then send it to ", a, ".");
    el.hidden = false;
  }
}
