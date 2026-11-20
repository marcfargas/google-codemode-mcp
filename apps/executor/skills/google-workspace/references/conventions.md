# Shared Google API conventions

Method briefs name the common arguments the method accepts. Follow the brief's
`commonParameters.path` with `describe` for their generated definitions. The
method's argument table takes precedence for method-specific types, defaults
and constraints. Google can define the same argument differently in another
service. A named schema and its fields belong to their service and version.

## Field masks and pagination

When the method accepts `fields`, use a comma-separated mask such as
`nextPageToken,files(id,name)` to project the Google response. This does not
change which results match a query. Include continuation and completeness
fields if your program relies on them.

Follow the method's list arguments. Gmail `users.messages.list` uses
`maxResults`; Drive `files.list` uses `pageSize`. A short or empty page
can still have a continuation token. See
[bounded pagination](skill://google-codemode-mcp/google-workspace/references/pagination.md)
for supported helper methods, bounds and incomplete results.

## Dates and numeric formats

Follow the format on the specific argument or schema field. A `date` is a
calendar-date string such as `2026-11-21`. For `date-time` fields that specify
RFC 3339, include an offset or `Z`, for example `2026-11-21T12:34:56Z`.
Drive `File.modifiedTime` is an RFC 3339 date-time. Gmail
`Message.internalDate` represents epoch milliseconds as an `int64` string.
Preserve string-encoded integers as strings, especially beyond JavaScript's
safe integer range. Follow the documented query syntax for dates inside a
Google search expression.

## Validation

Pass native options at the top level and JSON body fields under `requestBody`.
The executor rejects undeclared top-level options and checks supported
Discovery-derived types, requiredness, enums, patterns and numeric bounds
before dispatch. The body schema can allow additional fields. A documented
format such as `date-time` describes the Google wire contract. The executor
does not check Discovery's `format` annotation. Google can also enforce field
relationships, permissions and service-specific restrictions after dispatch.
Use the method brief and field details for those constraints, and see
[execution outcomes](skill://google-codemode-mcp/google-workspace/references/execution.md)
to tell a local refusal from a Google response.
