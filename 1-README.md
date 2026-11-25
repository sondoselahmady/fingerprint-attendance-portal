# Fingerprint Attendance Portal

A Google Apps Script web app for importing fingerprint-device punch logs, matching employee IDs to names, applying shift and grace-period rules, and reviewing attendance reports and analytics.

## Files
- `Code.gs`: server-side log parsing, storage, mappings, and attendance calculations.
- `Index.html`: upload interface and reports dashboard.

## Setup
Create a Google Apps Script project and add these files as `Code.gs` and `Index.html`. Deploy it as a web app from Apps Script. The app uses Script Properties for uploaded logs and employee mappings. Review access settings before deploying real employee data.
