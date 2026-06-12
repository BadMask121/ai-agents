import { loadFont as loadInter } from "@remotion/google-fonts/Inter";

const inter = loadInter("normal", {
  weights: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
  ignoreTooManyRequestsWarning: true,
});
export const FONT = inter.fontFamily;

export const C = {
  bg: "#0b0c0f",
  bg2: "#14161b",
  bg3: "#1b1e25",
  border: "#262a33",
  text: "#e9eaee",
  dim: "#9aa0ab",
  accent: "#d97757",
  accentSoft: "#e88a6c",
  blue: "#4aa3ff",
  green: "#39c07a",
  red: "#e5544b",
  yellow: "#e7b53b",
};

// Vertical 9:16 social format
export const W = 1080;
export const H = 1920;
export const FPS = 30;
