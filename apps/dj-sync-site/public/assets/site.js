// The only script on the site: renders the support contact, set in ONE
// place. Leave it null until the owner picks one (spec §8); the contact
// line then stays hidden and DJs see the "Copy diagnostics" steps only.
const SUPPORT_CONTACT = null; // e.g. { label: "help@example.com", href: "mailto:help@example.com" }

if (SUPPORT_CONTACT) {
  for (const el of document.querySelectorAll("[data-support-contact]")) {
    const a = document.createElement("a");
    a.href = SUPPORT_CONTACT.href;
    a.textContent = SUPPORT_CONTACT.label;
    el.append("Then send it to ", a, ".");
    el.hidden = false;
  }
}
