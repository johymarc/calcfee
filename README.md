# Calculadora de FEE — HubSpot UI Extension

A HubSpot UI Extension card, shown on the Ticket record tab, that calculates
the FEE for an operation based on each client's contracted rates and writes
the result back to the Ticket's properties.

This repository contains **two projects** with the identical UI, differing
only in where the rate data comes from:

| Project | Rate data source | Status |
|---|---|---|
| [`calculadora-fee/`](calculadora-fee/README.md) | HubDB table | Reference |
| [`calculadora-fee-files/`](calculadora-fee-files/README.md) | Excel file in File Manager | **Recommended** |

> Use `calculadora-fee-files` as the default — it doesn't depend on HubDB
> permissions and is simpler to maintain (just edit the Excel file and
> replace it). See each folder's README for details on its approach.

## How it works (summary)

1. The rep opens a Ticket → the card loads context (available companies + any previously saved data)
2. Searches for the company, picks channel/offer/type, enters the volume → clicks **Calculate FEE**
3. Reviews the result and confirms → the value is written to the Ticket's properties

Each project has 3 parts:
- **`src/app/cards/`** — the UI Extension (React) rendered on the Ticket
- **`src/app/functions/`** — the serverless functions containing the calculation logic
- **`src/app/*-hsmeta.json`** — app configuration (scopes, secrets, endpoints)

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- HubSpot CLI: `npm install -g @hubspot/cli`
- A HubSpot account with developer projects enabled

## Deploy

From inside the project folder you want to use:

```bash
hs init                                    # connect the CLI to your HubSpot account (once)
hs project upload --account=<account-name>
```

## HubSpot documentation

- [UI Extensions in private apps](https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/build-with-projects/create-ui-extensions)
- [Create CRM cards with Projects](https://developers.hubspot.com/docs/platform/create-custom-crm-cards-with-projects)
- [Fetching data in UI Extensions](https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/fetching-data)
