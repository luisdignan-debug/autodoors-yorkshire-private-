# UX Action Relocation Map

This is the internal map for the ergonomic dashboard pass. Existing functions remain available; this pass changes hierarchy, not capability.

## Global

- Flat sidebar links -> grouped navigation: Work, Money, Inbox, Admin.
- Root `/` -> `/today`, so the morning command centre is the default entry point.
- Top bar global actions -> page-aware primary action, quick search, sync inbox.
- Technical/export/admin actions -> keep available in page-level secondary actions or collapsed advanced sections.
- Supplier Invoices -> standalone `/supplier-invoices` page, while the original Finance section remains available.
- Exports/backup -> standalone `/exports` page, while System export links remain available.

## Dashboard

- Full finance metric wall -> Money summary only, with detailed Finance link.
- Today/action queues -> moved to `/today` and collapsed "More dashboard detail and action queues".
- Latest 20 leads -> moved to collapsed dashboard detail.
- System snapshot -> collapsed dashboard detail.
- Pipeline board -> compact pipeline remains visible.
- Setup/system warnings -> small dashboard warning section only when useful.

## Leads

- Dense lead table as default -> scan cards as default.
- Bulk archive/restore/status/delete -> collapsed "Bulk actions and table view".
- Advanced filters -> simple search/filter row plus quick chips.

## Lead / Job Detail

- Multiple workflow buttons at once -> first next-best action as primary.
- Other current actions -> secondary actions.
- Correction/history tools -> Advanced.
- Invoice/schedule/payment controls -> snapshot cards with detail panels.
- Raw job details and old drafts -> collapsed details/history.

## Supplier Emails

- Raw review list -> inbox-style cards.
- Raw email/extraction editing -> detail page and advanced edit form.
- Link/archive/review actions -> one primary "Review" from cards, full controls on detail.

## Finance

- All tables visible at once -> summary first, then tabs/sections using progressive disclosure.
- Supplier/customer payment forms -> "Record money movement" collapsed section.
- Exports -> secondary actions.
- Supplier invoice control -> dedicated `/supplier-invoices` page grouped by Payment due, Part paid, Overdue, Paid, Archived.

## Customer Invoices

- Full invoice table remains, but workflow grouped by Draft, Issued, Sent, Paid, Overdue.
- Technical invoice edits -> invoice detail advanced edit section.
- Email sending -> preview/copy first; send stays disabled unless feature flags are explicitly enabled.

## Installations / Technician Schedule

- Installation lists -> schedule sections: Today, This week, Needs booking, Awaiting confirmation, Payment due.
- Work order creation/technician setup -> visible but compact; correction details remain in work order detail.
- SMS/WhatsApp/calendar actions -> preview/export first; external sending remains feature-flagged.

## System / Settings

- Technical storage details -> collapsed technical details.
- Readiness cards -> visible health dashboard using Safe, Warning, Action needed language.
- Settings fields -> grouped business, invoice, payment, messaging/calendar setup sections.
- Download/export confidence -> standalone `/exports` plus System "Download my data".

## Function Preservation Checklist

- Manual lead creation -> `/manual-lead`, top action remains visible.
- Email sync -> top header secondary action and page-level forms remain.
- Checkatrade/webhook -> sync button and webhook route remain.
- Leads and lead detail actions -> primary next action, secondary actions, Advanced/history.
- Supplier emails -> inbox cards and detail controls remain.
- Supplier invoices/payments -> `/supplier-invoices` and Finance drawers.
- Customer invoices/PDF/email preview -> `/invoices` and invoice detail.
- Finance/job margins/payments/exports -> Finance tabs/drawers and `/exports`.
- Installations/work orders/technician digest/calendar files -> Installations and Technician Schedule.
- System/settings/export/admin tools -> System, Settings, Setup, Exports.
