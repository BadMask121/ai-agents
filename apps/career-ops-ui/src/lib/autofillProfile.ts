import { promises as fs } from "node:fs";
import path from "node:path";
import { p } from "./paths";

export type AutofillProfile = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  careerTitle: string;
  links: {
    linkedin: string;
    github: string;
    portfolio: string;
  };
  workHistory: Array<{
    company: string;
    title: string;
    startDate: string;
    endDate: string;
    location: string;
    bullets: string[];
  }>;
  education: Array<{
    school: string;
    degree: string;
    field: string;
    startDate: string;
    endDate: string;
  }>;
  defaults: {
    workAuthStatus: string;
    sponsorshipNeeded: string;
    salaryExpectation: string;
    noticePeriod: string;
    yearsExperience: string;
    pronouns: string;
  };
  freeText: {
    whyInterested: string;
    careerGoals: string;
  };
};

export const EMPTY_PROFILE: AutofillProfile = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  location: "",
  careerTitle: "",
  links: { linkedin: "", github: "", portfolio: "" },
  workHistory: [],
  education: [],
  defaults: {
    workAuthStatus: "",
    sponsorshipNeeded: "",
    salaryExpectation: "",
    noticePeriod: "",
    yearsExperience: "",
    pronouns: "",
  },
  freeText: { whyInterested: "", careerGoals: "" },
};

export async function readAutofillProfile(): Promise<AutofillProfile> {
  try {
    const raw = await fs.readFile(p.autofillProfile, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...EMPTY_PROFILE, ...parsed };
  } catch {
    return EMPTY_PROFILE;
  }
}

export async function writeAutofillProfile(
  profile: AutofillProfile,
): Promise<void> {
  await fs.mkdir(path.dirname(p.autofillProfile), { recursive: true });
  await fs.writeFile(
    p.autofillProfile,
    JSON.stringify(profile, null, 2),
    "utf-8",
  );
}
