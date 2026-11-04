// "today", "1 day ago", "6 days ago" (and the pt-BR forms). Pure, so it can be tested without a DOM.
export const ago = (days: number, lang: "en" | "pt-BR") =>
  lang === "en"
    ? days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`
    : days === 0 ? "hoje" : days === 1 ? "1 dia atrás" : `${days} dias atrás`;
