---
name: Lightning Web Components — GraphQL data and bold design
kind: knowledge
scope: global
roles: []
---

# Lightning Web Components: GraphQL data and bold design

Load when building or changing a Lightning Web Component: its data access (GraphQL queries and
mutations instead of Apex), its visual design, its layout on record, app and Experience pages, or
when a component shows wrong or missing data.

## Before writing a component

1. Check whether a standard component, Dynamic Forms, a related list or a report chart already does
   the job. A component is the last rung, not the first.
2. `list_metadata LightningComponentBundle` and `read_metadata` any component that looks close:
   extend it rather than building a second one.
3. `describe_sobject` every object you will read or write: exact API names, which fields are
   formula or read-only, which are managed (`ns__`).
4. Decide the page types (`lightning__RecordPage`, `lightning__AppPage`, `lightning__HomePage`,
   `lightningCommunity__Page`) and the widths it will live in: a record page sidebar is ~300px, a
   main region ~800px, an app page can be full width.
5. State in the plan how the component gets its data (the order below) and, if Apex, the reason.

## Data access: GraphQL first, Apex last

Choose in this order and stop at the first that fits:

1. **Base record components** (`lightning-record-form`, `lightning-record-edit-form`,
   `lightning-record-view-form`) for a plain form over one record.
2. **GraphQL wire** (`graphql` from `lightning/graphql`) for every other read: lists, related
   records, several objects in one request, filtering, sorting, pagination, aggregates.
3. **`executeMutation`** from `lightning/graphql` for create, update and delete.
4. **Apex**, only for a reason from the list below, named in the plan.

Do not add an `@AuraEnabled` method for a read or write GraphQL can do. When editing an existing
component that uses Apex for simple reads, propose migrating it rather than extending the Apex
(fewer classes, no test class to maintain, no coverage to find, FLS enforced for free).

Use `lightning/graphql`, not the older `lightning/uiGraphQLApi`, except for Mobile Offline, which
only the older module supports.

**Apex is still justified when:** the object is not supported by UI API; the component needs
access the running user lacks (system-mode logic, reason documented); the operation needs a
callout; several writes must commit or roll back together; the write must run server-side logic
that cannot live in a trigger or flow; or the query needs SOQL features GraphQL lacks, more than 10
subqueries, or volumes pagination cannot reasonably handle.

### Query pattern

```js
import { LightningElement, api, wire } from 'lwc';
import { gql, graphql } from 'lightning/graphql';

const QUERY = gql`
  query OpenCasesForAccount($accountId: ID, $first: Int) {
    uiapi {
      query {
        Case(
          where: { AccountId: { eq: $accountId }, IsClosed: { eq: false } }
          orderBy: { CreatedDate: { order: DESC } }
          first: $first
        ) {
          edges { node { Id CaseNumber { value } Subject { value } Priority { value displayValue } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export default class OpenCases extends LightningElement {
  @api recordId;
  cases = [];
  errors;
  wired;

  get variables() {
    return { accountId: this.recordId, first: 50 };
  }

  @wire(graphql, { query: QUERY, variables: '$variables' })
  handle(result) {
    this.wired = result; // keep it for refresh after a mutation
    const { data, errors } = result;
    this.errors = errors; // an array, and it can arrive alongside partial data
    this.cases = data?.uiapi.query.Case.edges.map(({ node }) => ({
      id: node.Id,
      number: node.CaseNumber.value,
      subject: node.Subject.value,
      priority: node.Priority.displayValue ?? node.Priority.value,
    })) ?? [];
  }
}
```

Rules that bite:

- Always name the operation (`query OpenCasesForAccount`); it is what shows up in server-side
  debugging and the network tab.
- Inputs go through `variables` exposed by a getter so the wire re-runs reactively. Never build
  query text from user input.
- Values are wrapped: `node.Name.value`, `displayValue` for formatted output. `Id` is not wrapped.
- Only 10 records return by default: set `first`. Up to 10 subqueries per query, each at most
  2,000 records. Page with `first` + `after: $cursor` from `pageInfo.endCursor`; with `upperBound`,
  `first` must be 200–2,000 and the bound must stay constant for that collection.
- Queries run with the user's object and field security. Mark fields some users cannot see as
  optional (v2) so one hidden field does not fail the query.
- Not every field is filterable or sortable; a rejected `where` means pick another field.
- Map the response into a flat view model in the handler, as above. Templates should not walk
  `edges.node.X.value`.

### Mutation pattern

```js
import { gql, executeMutation } from 'lightning/graphql';

const CLOSE_CASE = gql`
  mutation CloseCase($input: CaseUpdateInput!) {
    uiapi { CaseUpdate(input: $input) { Record { Id Status { value } } } }
  }
`;

async handleClose(event) {
  const { errors } = await executeMutation({
    query: CLOSE_CASE,
    operationName: 'CloseCase',
    variables: { input: { Id: event.target.dataset.id, Case: { Status: 'Closed' } } },
  });
  if (errors?.length) { this.showError(errors[0].message); return; }
  // refresh the stored wire result so the list reflects the change
}
```

- A mutation is an ordinary save: validation rules, duplicate rules, triggers and flows all run.
  A validation failure comes back in `errors`; show its message, it was written for the user.
- After a create or update, refresh the stored wire result (the refresh function the current
  `lightning/graphql` docs give for it); new or changed records are not guaranteed to appear
  otherwise. Deletes drop out of wire results automatically.
- `notifyRecordUpdateAvailable([{ recordId }])` tells other components on the page to refresh.

### When Apex is used anyway

`@AuraEnabled(cacheable=true)` for reads, non-cacheable for writes, `WITH USER_MODE` in the SOQL,
`refreshApex` only on the stored wired value. See "Salesforce Apex and LWC" for tests and limits.

## Design: bold, not default

A component that looks like every other SLDS card is invisible. Aim for something a user notices
and understands in two seconds, while still feeling native to Lightning (it sits beside standard
components on the same page) and staying accessible.

**Principles**

- **One job, one hero.** Decide the single thing the user must see first (a number, a status, the
  next action) and make it dominant: large type, strong weight, generous space. Everything else
  is secondary and quieter.
- **Hierarchy through type, not boxes.** A clear type scale (e.g. 12 / 14 / 20 / 32 / 48px),
  weight and colour contrast do the work that nested cards and borders do in default SLDS. Fewer
  borders, more whitespace.
- **Colour with meaning.** One accent for the primary action or brand moment, status colours only
  for status. A bold colour field (a tinted header band, a gradient behind the hero metric) is
  fine once per component, not everywhere.
- **Data forward.** Show values, trends and progress visually: big numbers with a delta, progress
  bars and rings, sparklines (inline SVG), timeline rails, stacked chips. A table is the last
  resort for more than a handful of rows, not the default.
- **Designed states.** Loading is a skeleton in the final layout, not a centred spinner. Empty is
  a sentence that says what will appear and the one action to take. Errors say what happened and
  what to do, in the component, not only a toast.
- **Motion with purpose.** Short (150–250ms) transitions on state changes and reveals, eased out;
  nothing that loops. Wrap all of it in `@media (prefers-reduced-motion: no-preference)`.
- **Responsive to its container, not the viewport.** The same component may sit in a 300px sidebar
  or a full-width app page. Use CSS container queries (`container-type: inline-size` on the root)
  to switch between a stacked and a wide layout.

**Mechanics**

- Put the component's design tokens as CSS custom properties on the root element, and derive them
  from SLDS global styling hooks where one exists, so org theming and SLDS 2 still flow through:
  `--hero-accent: var(--slds-g-color-accent-1, #0176d3);`. No raw hex scattered through rules.
- Keep base components (`lightning-input`, `lightning-button`, `lightning-combobox`,
  `lightning-datatable`) for form controls and anything interactive: they carry keyboard support,
  validation and screen-reader semantics you would otherwise rebuild. Be bold in layout, type,
  colour and data display around them; style them only through their documented styling hooks,
  never by reaching into their internals.
- Icons: `lightning-icon` with a meaningful `alternative-text`, or inline SVG with `aria-hidden`
  when decorative.
- Light DOM (`static renderMode = 'light'`) only when the page must style into the component or a
  third-party library needs it; the default shadow DOM keeps your CSS from leaking.
- Include a `.svg` bundle icon and a `masterLabel` and `description` in `.js-meta.xml` so the
  component is findable in App Builder; expose design attributes (`targetConfigs`) for the few
  settings an admin should tune, such as the title or record limit.

**Non-negotiable, however bold**

- Text contrast at least WCAG AA (4.5:1 body, 3:1 large text) on its real background, including
  text over a gradient or colour band.
- Every interactive element reachable and operable by keyboard, with a visible focus style.
- Colour is never the only signal: status also has an icon or a word.
- Touch targets at least 44px on anything that can be used on mobile.
- Lightning Locker / Lightning Web Security: no `eval`, no direct DOM access outside the
  component, third-party libraries loaded from a static resource with `loadScript`/`loadStyle`.

## Files, targets and tests

- `.html`, `.js`, `.css` (optional), `.js-meta.xml` with `<isExposed>`, `<masterLabel>` and
  `<targets>`. `@api recordId` and `@api objectApiName` are only populated on record pages.
- Import fields from `@salesforce/schema` rather than string names where the API allows it; a
  typo then fails at deploy instead of at runtime.
- Lightning Message Service for communication between unrelated components; events up, properties
  down between parent and child.
- Jest (`sfdx-lwc-jest`) with the wire adapter mocked; cover data, empty and error states.

## Experience sites

The guest or community profile needs object and field access for GraphQL queries to return data,
and the Apex class on the profile if Apex is used; the target must include
`lightningCommunity__Page`. The browser's console and network tabs (`read_console_logs`,
`read_network_requests`) show the GraphQL request and its `errors` when nothing else does.

## Definition of done

- Data comes from base components or GraphQL, or the plan names why Apex is needed.
- GraphQL operations are named, use variables, set `first`, handle `errors`, refresh after writes.
- The component has a clear hero, designed loading, empty and error states, and works at 300px
  and full width.
- Tokens derive from SLDS styling hooks; contrast, keyboard and focus checked.
- Exposed with label, description and targets; an admin can place it without reading code.
