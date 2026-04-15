# Value Discovery Guide — Enhanced Feed Search Package

This package includes the updated application with:
- separate **Company Name** and **Website URL** fields for stronger entity matching
- expanded **Recent Signals** sourcing across the attached feed catalog
- signals sorted **newest to oldest**
- a **5-year lookback window** applied to feed results where date metadata is available
- dynamic company/domain search feeds layered on top of the static catalog for broader match coverage
- full aligned front-end and back-end files

## Deploy

Render:
- Build Command: `npm install`
- Start Command: `npm start`

## Environment variables

- `OPENAI_API_KEY=your_project_api_key`
- `OPENAI_MODEL=gpt-4.1-mini`

## Notes

- Direct publisher RSS and Atom feeds often expose only their currently available feed items, not complete 5-year archives. This package supplements those feeds with company/domain search-driven feeds to improve 5-year signal coverage.
- The recent signals area shows matched items only and sorts them from newest to oldest.


## Version 2.3.0
- Added server-side de-duplication for Supporting Entity Notes and Recent Signals.
- When duplicate or syndicated signals are found across multiple sources, the app now keeps a single best record based on confidence first, then source quality, then recency.
