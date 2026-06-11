# Buyer Value UX Audit

## Buyer Friction Found

- The app had strong operational features, but the value was spread across many pages.
- The homepage still needed a clearer "what do I do today?" story.
- Demo/sales mode was missing, making it hard to show value without real customer data.
- Setup readiness existed in pieces, but not as a client onboarding wizard.
- Export confidence existed, but needed to be more prominent for buyer trust.

## Support Risks Found

- Missing quote amounts can make balances unclear.
- Supplier invoices can be entered without a recorded supplier order.
- Invoice settings can be incomplete before issuing real invoices.
- Admin login and durable storage must be checked before client handover.

## Improvements Made

- Added `/today` as the morning command centre.
- Added `/demo` and `DEMO_MODE=false` safe default.
- Added buyer-value metrics to the dashboard.
- Added setup wizard route and setup checklist.
- Added plain-English System warnings with fix buttons.
- Added supplier email and all-data exports.
- Added garage-door industry template structure.
- Added client and operator documentation.
