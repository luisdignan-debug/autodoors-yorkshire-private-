# Auto Doors Yorkshire Enquiry Manager

This app helps Auto Doors Yorkshire keep customer enquiries in one place.

It collects leads, creates a sensible draft reply, shows what needs attention, and keeps a human in control. It does **not** send replies automatically.

## What It Does

- Shows an admin dashboard at `/dashboard`.
- Lets you paste a Checkatrade/customer message into `/manual-lead`.
- Reads SiteGround mailbox enquiries when configured.
- Keeps the authorised Checkatrade dashboard connector available, disabled by default.
- Keeps the Checkatrade webhook endpoint at `/webhooks/checkatrade`.
- Deduplicates leads.
- Scores priority.
- Creates draft replies.
- Lets you update lead status.
- Tracks quote accepted, deposit, supplier order, delivery, installation, balance, review, and close-out stages.
- Detects likely supplier order and delivery emails and puts uncertain matches into review.
- Separates likely enquiries from supplier, recruitment, spam, marketing, and admin emails during mailbox sync.
- Tracks customer payments, supplier invoices, outstanding balances, and estimated job margin.
- Lets supplier emails and supplier invoices be reviewed, edited, linked, archived, or deleted.
- Provides CSV exports for leads, job finance, customer payments, and supplier invoices.
- Shows a system page for data permanence and backup/export checks.
- Exports the tracker workbook.

## What It Does Not Do

- It does not send customer replies automatically.
- It does not scrape public Checkatrade pages.
- It does not bypass CAPTCHA, 2FA, login checks, or security controls.
- It does not commit `.env`, passwords, cookies, or Playwright sessions.

## Setup

Install dependencies:

```powershell
npm install
npx playwright install chromium
```

Create local settings:

```powershell
copy .env.example .env
notepad .env
```

Fill the important bits:

```text
DRY_RUN=true
AUTO_SEND=false
ADMIN_USERNAME=choose-a-login
ADMIN_PASSWORD=choose-a-password
BUSINESS_EMAIL=info@autodoorsyorkshire.com
DATABASE_PROVIDER=json
IMAP_PASSWORD=
SMTP_PASSWORD=
CHECKATRADE_ENABLED=false
CHECKATRADE_PASSWORD=
```

Put real passwords only in `.env`, Render environment variables, or secure secrets. Never put them in `.env.example`.

## Run Locally

```powershell
npm run dev
```

Open:

```text
http://localhost:3000/dashboard
```

Health check:

```text
http://localhost:3000/health
```

## Add A Manual Lead

Open:

```text
http://localhost:3000/manual-lead
```

Paste the Checkatrade enquiry, customer email, phone note, or message.

The app will:

1. Extract useful details.
2. Check for duplicates.
3. Create a lead.
4. Generate a draft reply.
5. Send you to the lead detail page.

Manual lead paste is only for enquiries you are authorised to view.

## Review And Send Replies

Open a lead from `/leads`.

Use:

- Copy draft reply.
- Open Checkatrade source link, if present.
- Change status.
- Add notes.
- Add follow-up date.

Send the reply manually from email or Checkatrade. Keep `AUTO_SEND=false`.

## Daily Dashboard Workflow

Open `/dashboard` first.

Use the queue cards like a control centre:

- `New enquiries needing response`: reply or create a draft.
- `Quotes to send`: site survey or quote still needs sending.
- `Quotes awaiting customer decision`: chase the customer if needed.
- `Accepted quotes needing deposit`: ask for the deposit.
- `Deposits received - order supplier now`: place the supplier order.
- `Supplier orders awaiting confirmation`: look for supplier confirmation.
- `Orders awaiting delivery`: keep an eye on delivery date or lead time.
- `Delivery due soon`: check whether the door has arrived.
- `Delivered - book installation`: arrange the install date.
- `Balance/payment due`: request or chase the final balance.
- `Supplier emails needing review`: link unclear supplier emails manually.

Red means urgent or overdue, amber means monitor soon, green means on track.

## Post-Quote Job Pipeline

For repair jobs, the short path is:

```text
New enquiry -> Quote sent -> Quote accepted -> Visit booked -> Repair completed -> Payment requested -> Paid -> Review requested -> Closed
```

For new or replacement garage doors, the longer path is:

```text
New enquiry -> Quote sent -> Quote accepted -> Deposit requested -> Deposit received -> Supplier order placed -> Supplier confirmation received -> Awaiting delivery -> Delivered -> Installation booked -> Installation completed -> Balance requested -> Balance paid -> Review requested -> Closed
```

On each lead page, the app shows:

- customer details;
- current stage;
- next best action;
- timeline;
- only the workflow buttons that make sense at that stage;
- draft customer update text for copying and editing.

Nothing is sent automatically.

## Supplier Email Review

The SiteGround mailbox sync now also looks for supplier/order emails.

It detects wording such as:

```text
order confirmation, sales order, purchase order, invoice, estimated delivery, lead time, dispatch, delivered, delayed, back order
```

When the app can confidently match the supplier email to a job, it updates the job with:

- supplier name;
- order reference;
- delivery date;
- lead-time range;
- delivery status.

When the match is not clear, the email appears at:

```text
/supplier-emails
```

Review it manually before changing the job.

The review screen at `/supplier-emails` includes filters and search. Open an item to edit extracted supplier details, link it to the right job, mark it reviewed, archive it, or delete it. This keeps supplier order confirmations, invoice emails, and delivery updates out of the lead queue unless a human confirms they matter.

## Finance And Payments

Open:

```text
/finance
```

This is the working finance view for the technician and business owner. It shows:

- open pipeline value;
- accepted job value;
- deposits requested and received;
- customer money still outstanding;
- supplier invoices received;
- supplier money owed;
- overdue customer and supplier payment warnings;
- expected gross margin by job.

Customer payments can be recorded from `/finance` or from an individual lead page. Supplier invoices can be recorded against a job, edited when the amount or payment status changes, archived when no longer active, or deleted if entered in error.

Balances are calculated automatically from the source records:

- customer payments;
- supplier invoices;
- supplier payments.

The lead page shows customer balance outstanding, supplier amount owed, estimated gross margin, overpayments, and margin warnings. After installation is completed, the balance request/payment form uses the calculated outstanding balance so the technician does not need to work it out manually.

This is operational tracking, not formal accounting software. Use it to keep jobs moving and avoid missing money; keep your accountant/bookkeeping process as the source of truth for statutory accounts.

## Data Permanence And Exports

Open:

```text
/system
```

The app does not use SQLite. It stores one application state document either in a local JSON file for development or in Render Postgres for the live service. For live use, the safe Render setup is:

```text
DATABASE_PROVIDER=postgres
DATABASE_URL=<Render Postgres internal database URL>
```

The system page reports whether the current storage is durable. It also links to exports:

```text
/export/tracker
/export/leads.csv
/export/jobs.csv
/export/payments.csv
/export/supplier-invoices.csv
```

Use these exports before major changes and whenever you want a local safety copy.

## SiteGround Email

Set:

```text
EMAIL_PROVIDER=siteground
IMAP_HOST=gukm1010.siteground.biz
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER=info@autodoorsyorkshire.com
IMAP_PASSWORD=your-real-password-in-.env-only
SMTP_HOST=gukm1010.siteground.biz
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=info@autodoorsyorkshire.com
SMTP_PASSWORD=your-real-password-in-.env-only
```

Dry run:

```powershell
npm run sync:email:dry-run
```

Live processing:

```powershell
$env:DRY_RUN="false"
npm run sync:email
```

The app still does not send replies.

## Checkatrade Dashboard Connector

Use only with permission for the trader account.

Set:

```text
CHECKATRADE_ENABLED=false
CHECKATRADE_LOGIN_URL=https://membersapp.checkatrade.com/
CHECKATRADE_DASHBOARD_URL=https://membersapp.checkatrade.com/
CHECKATRADE_ENQUIRIES_URL=https://membersapp.checkatrade.com/
CHECKATRADE_USERNAME=info@autodoorsyorkshire.com
CHECKATRADE_PASSWORD=
CHECKATRADE_HEADLESS=false
```

Login locally:

```powershell
npm run checkatrade:login
```

Enter password and the email verification code yourself in the browser. When fully logged in, press Enter in PowerShell. The session is saved in `secure/checkatrade-auth.json`, which is ignored by Git.

Dry run:

```powershell
npm run checkatrade:dry-run
```

Live pull after testing:

```powershell
$env:DRY_RUN="false"
$env:CHECKATRADE_ENABLED="true"
npm run checkatrade:pull
```

If selectors fail:

```powershell
npm run checkatrade:debug
```

Do not commit debug screenshots or HTML.

## Webhook

The endpoint remains:

```text
POST /webhooks/checkatrade
```

Render URL example:

```text
https://your-app-name.onrender.com/webhooks/checkatrade
```

Keep IP allowlisting or HMAC enabled for live use.

## Customer Invoices

Open **Settings** first and check the invoice setup:

- Company legal name: `YORKSHIRE AUTO DOORS LTD`
- Trading name: `Autodoors Yorkshire`
- Company number: `14637200`
- Registered office address is pre-filled from the supplied company details.
- VAT is off by default. Do not enable it until the VAT number is confirmed.
- Add bank details before issuing live invoices.

Invoices are draft-first. Create them from **Invoices** or from a job page:

- Deposit invoice
- Balance invoice
- Final invoice
- Pro forma / payment request

Draft invoices do not consume a final invoice number. Click **Issue invoice number** only after checking customer details, VAT mode and bank details. Issued invoice numbers are sequential, for example `ADY-000001`, and are never reused even if an invoice is voided.

Each invoice can generate a PDF. Email sending is preview-only unless all of these are deliberately true/configured:

```text
SEND_EMAILS_ENABLED=true
AUTO_SEND=true
SMTP_PASSWORD=<real mailbox password>
```

Default is safe:

```text
SEND_EMAILS_ENABLED=false
AUTO_SEND=false
```

## Technician Schedule

Use **Technician Schedule** to add the technician and create work orders from jobs.

Work orders support:

- Survey
- Repair
- Installation
- Follow-up
- Service
- Other

The schedule page shows today, tomorrow, this week, unscheduled work and completed work. Daily and weekly technician digest pages generate message previews that can be copied manually.

SMS and WhatsApp are off by default:

```text
SEND_SMS_ENABLED=false
SEND_WHATSAPP_ENABLED=false
```

Twilio placeholders are available in `.env.example`, but messages are not sent unless the feature flag is enabled and credentials are configured. WhatsApp may require approved templates, so template names are kept configurable.

Calendar support starts with `.ics` files. Download the `.ics` file from a work order and open/import it into Apple Calendar. CalDAV/iOS sync is scaffolded but disabled unless all CalDAV settings are supplied:

```text
CALENDAR_SYNC_ENABLED=false
CALDAV_ENABLED=false
```

## Render

The repo includes `render.yaml`.

Deploy as a Blueprint from GitHub. Render should use:

```text
Build command: npm install
Start command: npm start
Health check path: /health
```

The Blueprint also provisions a Render Postgres database and sets:

```text
DATABASE_PROVIDER=postgres
DATABASE_URL=<provided by Render>
```

Locally, the app still defaults to the JSON tracker file in `data/enquiry-manager.json`. On Render, Postgres keeps leads, job stages, logs, supplier email review records, finance records, and processed message IDs through restarts and redeploys.

Set private environment variables in Render, especially:

```text
ADMIN_USERNAME
ADMIN_PASSWORD
IMAP_PASSWORD
SMTP_PASSWORD
CHECKATRADE_PASSWORD
CHECKATRADE_WEBHOOK_SECRET
```

Render free services may sleep. If the app seems slow the first time you open it, wait for it to wake up.

## Change Templates

Edit:

```text
config/reply-templates.json
```

There are templates for:

- Cable repair.
- Door stuck open or insecure.
- Door stuck shut.
- Electric/operator issue.
- New door quote.
- Service.
- General quote.
- Missing information.
- Out-of-area.
- Follow-up.

## Rotate Passwords

Rotate passwords if a real secret is committed, pushed, shown in logs, pasted into chat, or exposed in screenshots.

Do not rotate just because `.env` exists locally. `.env` is supposed to hold local secrets and is ignored by Git.

## Troubleshooting

IMAP login fails:

- Check `IMAP_HOST`, `IMAP_USER`, and `IMAP_PASSWORD`.
- Confirm SiteGround mailbox login works in webmail.

SMTP login fails:

- Check `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASSWORD`.
- Keep `AUTO_SEND=false`; SMTP is for future tested sending only.

Checkatrade login fails:

- Run `npm run checkatrade:login` locally.
- Complete password and email code manually.
- Delete `secure/checkatrade-auth.json` and login again if needed.

Lead not appearing:

- Check filters in `.env`.
- Check duplicate notes.
- Run dry-run first.

Duplicate lead:

- Open the lead and read the Notes field.

Draft reply missing:

- Check the lead has a job description.
- Run tests with `npm test`.

## Commands

```powershell
npm run dev
npm run start
npm run build
npm run test
npm run db:migrate
npm run sync:email
npm run sync:email:dry-run
npm run checkatrade:login
npm run checkatrade:dry-run
npm run checkatrade:pull
```
