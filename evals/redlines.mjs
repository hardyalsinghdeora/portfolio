// Text that must never be published: any Indian mobile number (optionally +91-prefixed), and
// employer-internal vocabulary and company numbers that may be said in an interview but never
// published (career-profile redlines.json and the verbal-only rows of the master résumé).
// Used by the build-time tests (knowledge base, pages, job-site text) and by the answer evals.
export const PHONE = /(?:\+91[-\s]?)?\b[6-9]\d{9}\b/;
export const REDLINES = /\b(Mindspark|Naandi|Shiksha|SchoolSite|School Site|Navigator|da_orderMaster|common_user_details|educatio_educat|ei-order|navigator-aggregator|ei-navigator-ui|ei-mcp-gateway|Zoho)\b|\b(ASSET|CARES|SZM|NSH)\b|\bNAV-\d|500k|500,000|577|1,689,499|363,609|₹\s?\d|\bcr(ore)?\b/;
