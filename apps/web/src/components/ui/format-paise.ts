// Money formatting lives in packages/shared so the API and the web app use one copy.
// Money is always integer paise.
export { formatPaise, groupIndian, type FormatPaiseOptions } from "@leaklens/shared";
