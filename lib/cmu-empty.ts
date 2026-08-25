// Event handlers run in the browser, so the server render never needs the 4 MB
// pronunciation table. The client build keeps the real dictionary.
export const dictionary: Record<string, string> = {};
