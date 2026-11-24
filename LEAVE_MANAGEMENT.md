# Employee & Leave Management

Employees apply for leave on WhatsApp. Reporting managers approve or reject on WhatsApp. HR and admins monitor everything in the dashboard. There are no employee or manager logins.

## Pieces
| Part | What it does |
|---|---|
| `supabase/migrations/014_leave_management.sql` | New tables: `employees`, `employee_audit`, `leave_requests` (LV-YYYY-NNNN), `leave_request_audit`, `leave_action_tokens`, `leave_notifications`, `leave_sessions`, `leave_inbound`, plus RLS and the server functions `hr_save_employee`, `hr_set_employee_status`, `leave_identify`, `leave_submit` and `leave_decide`. |
| `supabase/migrations/015_leave_fast_check.sql` | `leave_check()`: a fast pre-check (~0.1 s) that decides whether a WhatsApp message could be about leave. |
| `supabase/functions/leave-bot` | The WhatsApp conversation: from date → to date → reason → confirm; manager Approve/Reject (reject asks for a reason); notifications. |
| n8n chatbot (`6f46qVYV0jVMhzON`) | `Receive Message → Leave check → (maybe leave) Leave router → Send leave message`. Every other message goes on unchanged to the existing chatbot through `Continue to chatbot`. |
| `hr.js` + 2 menu items | **Employee Management** (add, edit, deactivate, history) and **Leave Management** (view only). |

## Who sees what
- HR is chat_staff with the department "Hr", plus admins. Only they see the two menu items. The database (RLS) enforces this too.
- Nobody can change a leave status from the dashboard. Only `leave_decide()` can, through leave-bot, and only for the active reporting manager whose WhatsApp number is on the request.

## Settings (`chat_settings`)
| key | meaning |
|---|---|
| `leave_hr_whatsapp` | HR's notification number (919220822566). |
| `leave_test_redirect` | **Test mode.** When set, every leave message goes only to this number, and that number may act as the manager. Delete this row to go live. |

## WhatsApp templates (UTILITY, approved by Meta)
These are used when the person hasn't messaged in the last 24 hours:
- `leave_manager_request` (Approve / Reject buttons)
- `leave_hr_new`
- `leave_hr_approved`
- `leave_hr_rejected`
- `leave_employee_approved`
- `leave_employee_rejected`
- `leave_hr_alert`

## Go live
1. Check that all 7 templates are APPROVED: Campaigns → Templates → Refresh from WhatsApp.
2. `delete from chat_settings where key = 'leave_test_redirect'; delete from leave_sessions;`

## Rollback
1. In n8n, restore version `8a3d91cd-4e77-4791-97c9-9577b4b92ddf` (the version before Leave Management) and publish it. The chatbot then works exactly as before.
2. In the dashboard, redeploy the previous production deployment, or revert the merge commit.
3. The database tables can stay. They are only used by the pieces above, so nothing else depends on them.
