Release 3.0.3

Pinned to Node 20.x for Render compatibility. package-lock.json removed to avoid bad registry URLs in prior lockfiles.

Release: 3.0.2

Release 3.0.1

This package includes feedCatalog.js and the deep-dive website intelligence pipeline.

# Value Discovery Guide — AI Assisted v3.0.0

This release adds a multi-phase website deep-dive engine on top of the existing entity and signal workflow.

## New deep-dive capabilities

1. Website discovery
   - Detects press/news, governance, reports, operations, and entity-related sections on the submitted company website.
2. Corporate reports
   - Finds and ranks report-style documents such as annual reports, financial reports, ESG/sustainability documents, governance documents, and NFPS-style documents when discoverable from public pages.
3. Operational footprint extraction
   - Pulls likely operational statements from discovered pages and documents relating to manufacturing, R&D, logistics, warehouses, production footprint, and geographic coverage.
4. Linked entities
   - Identifies likely affiliate, group, country, brand, or related company websites linked from the root site.
5. Recursive affiliate review
   - Performs a lighter second-pass review on trusted linked sites to capture supporting notes, documents, and operational facts.

## Analysis options

The Company Intelligence screen now includes five selectable deep-dive options:
- Website discovery
- Corporate reports
- Operational footprint
- Linked entities
- Recursive affiliate review

## Notes

- The site interrogation is intentionally bounded to avoid runaway crawling.
- Publicly accessible pages and linked documents are used; private/login-protected resources are not accessed.
- PDF extraction is heuristic and best-effort for public report discovery.
- Recent Signals and Supporting Entity Notes are deduplicated and ranked server-side.

## Deploy

Set these environment variables:
- `OPENAI_API_KEY`
- optional: `OPENAI_MODEL`

Start with:

```bash
npm install
npm start
```


Deployment note: node_modules is intentionally excluded from this package and should not be committed to Git. Render will install dependencies from package.json and package-lock.json during deploy.


Release 3.0.4 fixes a frontend runtime error where deep-dive analysis options were referenced before the helper function was defined.


## Release

Current package version: 3.0.5

This release adds stricter crawl and PDF limits, timeout guards, and better JSON error reporting for large websites such as Ceva.
