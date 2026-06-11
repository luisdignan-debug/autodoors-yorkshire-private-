# Backup And Export

The trader must be able to leave with their data.

Go to **System -> Download my data** and download:

- Workbook;
- All data JSON;
- Leads CSV;
- Jobs CSV;
- Customer invoices CSV;
- Customer payments CSV;
- Supplier invoices CSV;
- Supplier payments CSV;
- Supplier emails CSV.

For live Render use, storage should be backed by Render Postgres or another persistent store. Local file storage on Render is not enough for serious live use unless a persistent disk is configured.

Keep exports somewhere safe, such as a secure cloud folder controlled by the business owner.
