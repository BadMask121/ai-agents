/* eslint-disable */
// career-ops-ui autofill engine. Loaded by the bookmarklet on a job-application
// page. Reads window.__CAREER_OPS_TOKEN and window.__CAREER_OPS_BASE, fetches
// the user's profile, walks form fields, fills what it can match, and shows a
// floating result overlay.
(function () {
  "use strict";

  if (window.__CAREER_OPS_AUTOFILL_RUNNING) return;
  window.__CAREER_OPS_AUTOFILL_RUNNING = true;

  var TOKEN = window.__CAREER_OPS_TOKEN;
  var BASE = window.__CAREER_OPS_BASE;

  function showOverlay(html, kind) {
    var existing = document.getElementById("career-ops-autofill-overlay");
    if (existing) existing.remove();
    var el = document.createElement("div");
    el.id = "career-ops-autofill-overlay";
    el.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
      "background:" + (kind === "error" ? "#7f1d1d" : "#0f172a") + ";" +
      "color:#f1f5f9;padding:12px 14px;border-radius:10px;" +
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;" +
      "max-width:320px;box-shadow:0 10px 30px rgba(0,0,0,.35);";
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">' +
      '<div style="flex:1;min-width:0">' + html + '</div>' +
      '<button id="career-ops-autofill-close" style="background:transparent;border:0;color:#cbd5e1;font-size:18px;line-height:1;cursor:pointer;padding:0">×</button>' +
      "</div>";
    document.body.appendChild(el);
    document
      .getElementById("career-ops-autofill-close")
      .addEventListener("click", function () {
        el.remove();
        window.__CAREER_OPS_AUTOFILL_RUNNING = false;
      });
  }

  if (!TOKEN || !BASE) {
    showOverlay(
      "<b>Autofill not configured.</b><br>The bookmarklet needs a token and base URL.",
      "error",
    );
    return;
  }

  // Match patterns: semantic key → list of regex patterns to test against
  // the field's combined label text (label + placeholder + name + id + aria).
  var RULES = [
    ["firstName", [/\b(first[\s_-]*name|given[\s_-]*name|fname|forename)\b/i]],
    ["lastName", [/\b(last[\s_-]*name|surname|family[\s_-]*name|lname)\b/i]],
    ["fullName", [/\b(full[\s_-]*name|your[\s_-]*name|^name$|legal[\s_-]*name)\b/i]],
    ["email", [/\b(e[\s_-]?mail|email[\s_-]*address)\b/i]],
    ["phone", [/\b(phone|mobile|telephone|cell|contact[\s_-]*number)\b/i]],
    ["linkedin", [/linkedin/i]],
    ["github", [/git[\s_-]?hub/i]],
    ["portfolio", [/\b(portfolio|website|personal[\s_-]*site|homepage|url)\b/i]],
    ["location", [/\b(location|city|current[\s_-]*(address|city)|where[\s_-]*do[\s_-]*you[\s_-]*live)\b/i]],
    ["careerTitle", [/\b(current[\s_-]*(title|role|position)|present[\s_-]*(title|role)|job[\s_-]*title)\b/i]],
    ["currentCompany", [/\b(current[\s_-]*(employer|company)|present[\s_-]*employer|employer)\b/i]],
    ["workAuthStatus", [/\b(work[\s_-]*authorization|authorized[\s_-]*to[\s_-]*work|right[\s_-]*to[\s_-]*work)\b/i]],
    ["sponsorshipNeeded", [/\b(sponsorship|visa[\s_-]*sponsor|require[\s_-]*sponsor)\b/i]],
    ["salaryExpectation", [/\b(salary[\s_-]*(expectation|requirement)|expected[\s_-]*(salary|comp)|comp[\s_-]*expectation)\b/i]],
    ["noticePeriod", [/\b(notice[\s_-]*period|how[\s_-]*soon[\s_-]*can[\s_-]*you[\s_-]*start|earliest[\s_-]*start)\b/i]],
    ["yearsExperience", [/\b(years[\s_-]*of[\s_-]*experience|years[\s_-]*experience|yoe)\b/i]],
    ["pronouns", [/\bpronouns\b/i]],
  ];

  function flattenProfile(p) {
    var current = (p.workHistory && p.workHistory[0]) || {};
    return {
      firstName: p.firstName,
      lastName: p.lastName,
      fullName: [p.firstName, p.lastName].filter(Boolean).join(" "),
      email: p.email,
      phone: p.phone,
      location: p.location,
      careerTitle: p.careerTitle || current.title || "",
      currentCompany: current.company || "",
      linkedin: (p.links && p.links.linkedin) || "",
      github: (p.links && p.links.github) || "",
      portfolio: (p.links && p.links.portfolio) || "",
      workAuthStatus: (p.defaults && p.defaults.workAuthStatus) || "",
      sponsorshipNeeded: (p.defaults && p.defaults.sponsorshipNeeded) || "",
      salaryExpectation: (p.defaults && p.defaults.salaryExpectation) || "",
      noticePeriod: (p.defaults && p.defaults.noticePeriod) || "",
      yearsExperience: (p.defaults && p.defaults.yearsExperience) || "",
      pronouns: (p.defaults && p.defaults.pronouns) || "",
    };
  }

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(s);
    }
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return "\\" + c;
    });
  }

  function labelTextFor(input) {
    var parts = [];
    if (input.id) {
      var lbl = document.querySelector('label[for="' + cssEscape(input.id) + '"]');
      if (lbl && lbl.textContent) parts.push(lbl.textContent);
    }
    var wrap = input.closest && input.closest("label");
    if (wrap && wrap.textContent) parts.push(wrap.textContent);
    if (input.getAttribute("aria-label")) parts.push(input.getAttribute("aria-label"));
    if (input.getAttribute("placeholder")) parts.push(input.getAttribute("placeholder"));
    if (input.name) parts.push(input.name);
    if (input.id) parts.push(input.id);
    if (input.getAttribute("aria-labelledby")) {
      var ids = input.getAttribute("aria-labelledby").split(/\s+/);
      for (var i = 0; i < ids.length; i++) {
        var ref = document.getElementById(ids[i]);
        if (ref && ref.textContent) parts.push(ref.textContent);
      }
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function matchKey(text) {
    for (var i = 0; i < RULES.length; i++) {
      var key = RULES[i][0];
      var patterns = RULES[i][1];
      for (var j = 0; j < patterns.length; j++) {
        if (patterns[j].test(text)) return key;
      }
    }
    return null;
  }

  // React/Vue listen for native input events on the prototype setter, not on
  // direct .value assignment. Use the native setter then dispatch input+change.
  function setReactValue(el, value) {
    var proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) {
      setter.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setSelectValue(sel, value) {
    var v = String(value).toLowerCase();
    for (var i = 0; i < sel.options.length; i++) {
      var opt = sel.options[i];
      var text = (opt.textContent || "").toLowerCase().trim();
      var ov = (opt.value || "").toLowerCase().trim();
      if (ov === v || text === v || text.indexOf(v) !== -1) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function fillField(el, value) {
    if (value == null || value === "") return false;
    var tag = el.tagName;
    if (tag === "SELECT") return setSelectValue(el, value);
    if (tag === "TEXTAREA") {
      setReactValue(el, value);
      return true;
    }
    var type = (el.type || "text").toLowerCase();
    if (type === "checkbox" || type === "radio" || type === "file" ||
        type === "submit" || type === "button" || type === "hidden") {
      return false;
    }
    setReactValue(el, value);
    return true;
  }

  function isVisible(el) {
    if (!el.offsetParent && el.type !== "hidden") {
      var style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }

  function walk(root, profile, stats, unmatched) {
    var inputs = root.querySelectorAll("input, textarea, select");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (!isVisible(el)) continue;
      var type = (el.type || "").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" ||
          type === "file" || el.disabled || el.readOnly) continue;

      var text = labelTextFor(el);
      var key = matchKey(text);
      if (!key) {
        if (text) unmatched.push(text.slice(0, 60));
        continue;
      }
      var value = profile[key];
      if (!value) {
        stats.noValue++;
        continue;
      }
      if (el.value && el.value.length > 0) {
        stats.alreadyFilled++;
        continue;
      }
      if (fillField(el, value)) stats.filled++;
      else stats.failed++;
    }
  }

  fetch(BASE + "/api/profile", {
    headers: { Authorization: "Bearer " + TOKEN },
    mode: "cors",
    credentials: "omit",
  })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (profile) {
      var flat = flattenProfile(profile);
      var stats = { filled: 0, alreadyFilled: 0, noValue: 0, failed: 0 };
      var unmatched = [];
      walk(document, flat, stats, unmatched);

      var iframes = document.querySelectorAll("iframe");
      var crossOriginIframes = 0;
      for (var i = 0; i < iframes.length; i++) {
        try {
          // Same-origin iframes have an accessible contentDocument.
          if (iframes[i].contentDocument) {
            walk(iframes[i].contentDocument, flat, stats, unmatched);
          }
        } catch (_e) {
          crossOriginIframes++;
        }
      }

      var msg = "<b>Autofill</b><br>Filled " + stats.filled +
        ", already filled " + stats.alreadyFilled +
        (stats.failed ? ", failed " + stats.failed : "") +
        (crossOriginIframes ? "<br><span style=\"color:#fbbf24\">⚠ " + crossOriginIframes + " cross-origin iframe(s) skipped</span>" : "");
      if (unmatched.length) {
        var sample = unmatched.slice(0, 5).map(function (s) {
          return "<li style=\"margin:2px 0\">" +
            s.replace(/[<>&]/g, function (c) { return ({"<":"&lt;",">":"&gt;","&":"&amp;"})[c]; }) +
            "</li>";
        }).join("");
        msg += "<div style=\"margin-top:8px;color:#cbd5e1;font-size:11px\">Unmatched (" +
          unmatched.length + "):<ul style=\"margin:4px 0 0 14px;padding:0\">" + sample +
          "</ul></div>";
      }
      showOverlay(msg);
      window.__CAREER_OPS_AUTOFILL_RUNNING = false;
    })
    .catch(function (err) {
      showOverlay(
        "<b>Autofill failed.</b><br>" + (err && err.message ? err.message : "Unknown error"),
        "error",
      );
      window.__CAREER_OPS_AUTOFILL_RUNNING = false;
    });
})();
