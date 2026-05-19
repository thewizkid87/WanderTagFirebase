# Client API Migration Notes

This file maps the legacy client/printer-facing endpoints to the Firebase-side flow.

## Legacy to New

### Auth

- Legacy: `POST /crm/api/v1/clientApi/login/init`
  - Body: `phonePrefix`, `phone`
  - New: `POST /auth/start`
  - Body: `phonePrefix`, `phone`

- Legacy: `POST /crm/api/v1/clientApi/login/complete`
  - Body: `verificationUuid`, `verificationCode`
  - New: `POST /auth/verify`
  - Body: `attemptId`, `code`, `phonePrefix`, `phone`

### User profile

- Legacy: `GET /crm/api/v1/clientApi/userData`
  - New: `GET /me`

- Legacy: `PUT /crm/api/v1/clientApi/userData`
  - New: `PUT /me`

### Kids

- Legacy: `POST /crm/api/v1/clientApi/kid`
  - New: `POST /kids`

- Legacy: `PUT /crm/api/v1/clientApi/kid/{kidId}`
  - New: `PUT /kids/{kidId}`

- Legacy: `DELETE /crm/api/v1/clientApi/kid/{kidId}`
  - New: `DELETE /kids/{kidId}`

### Prints

- Legacy: `POST /crm/api/v1/clientApi/print`
  - New: `POST /tags`

### Scan history

- Legacy: `GET /crm/api/v1/clientApi/scan/{kidId}`
  - New: `GET /kids/{kidId}/scans`

- Legacy: `POST /crm/api/v1/clientApi/scan/{scanCode}`
  - New: `POST /scans/{publicCode}`

### Printer registration

- Legacy: `POST /crm/api/v1/printerApi/register`
  - New: `POST /printers/register`

## Notes

- The new client flow is a clean break from the legacy endpoints.
- The printer firmware and client code should be updated together after this backend scaffold is validated.

