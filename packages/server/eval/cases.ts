/**
 * Admin-style prompts with the investigation already done, so the eval measures design judgement
 * and skill use, not Salesforce API access. `must` are properties a correct reply has; `mustNot`
 * are the anchoring mistakes the prompts and skills exist to prevent. A `mustNot` may never name a
 * design the plan should list under "Alternatives considered": rejecting it is the correct reply. `apt` names the skills a
 * sensible agent loads first for this kind of work (any one of them counts).
 */
export interface EvalCase {
  id: string;
  ask: string;
  findings: string[];
  must: RegExp[];
  mustNot?: RegExp[];
  apt: string[];
}

const FLOWS = 'Salesforce flows';
const SECURITY = 'Salesforce security and guest users';
const APEX = 'Salesforce Apex and LWC';
const DATA = 'Salesforce data model and deployment';
const EVENTS = 'Salesforce events, integration and email';
const OPS = 'Salesforce admin operating model';
const WHY = 'Playbook — why is this happening';
const NEW_FIELD = 'Playbook — add a field and make it visible';

export const CASES: EvalCase[] = [
  {
    id: 'guest-verification-email',
    ask: 'When someone finishes the onboarding form on our public site, their Contact gets updated. We want them to receive a verification email straight after. Plan it.',
    findings: [
      'The onboarding site is an Experience Cloud site; the form is a screen flow running as the site guest user, set to system context without sharing.',
      'The flow updates an existing Contact (Onboarding_Status__c = Submitted).',
      'There is one after-save record-triggered flow on Contact already (Contact_AfterSave_Assign_Owner).',
      'OrgWideEmailAddress query returns no rows: no verified org-wide address exists.',
      'Org kind: production, protected. Deliverability: All email.',
    ],
    must: [/platform event/i, /org-?wide/i, /alternatives considered/i, /guest/i],
    mustNot: [/^(?!.*platform event).*run asynchronously.*$/is],
    apt: [EVENTS, SECURITY, FLOWS],
  },
  {
    id: 'cannot-see-field',
    ask: 'Maria in Sales says the Renewal Date field on Contract is not there for her but I can see it. Why?',
    findings: [
      'Contract.Renewal_Date__c exists, type Date, on the Contract Layout.',
      'FieldPermissions: read/edit granted only by permission set Sales_Manager.',
      "Maria's PermissionSetAssignment rows: Sales_User, Contract_Reader. Her profile is Standard User.",
      'UserRecordAccess for the contract she opened: HasReadAccess true.',
    ],
    must: [/Sales_User/, /permission set/i, /field-?level security|FLS/i],
    apt: [SECURITY, WHY],
  },
  {
    id: 'flow-did-not-fire',
    ask: 'Our flow is supposed to set Priority to High when Amount goes over 50k but it did nothing on the opportunity I just edited. Why?',
    findings: [
      'Opportunity_AfterSave_Priority is active, version 3, record-triggered on update.',
      'Entry condition: Amount > 50000, with "only when a record is updated to meet the condition requirements" on.',
      'The opportunity edited had Amount 80000 before and after the edit; the user changed Close Date.',
      'No fault or error in the debug log; the flow name does not appear in it.',
    ],
    must: [/condition requirements|updated to meet|already (met|over|above)/i],
    apt: [FLOWS, WHY],
  },
  {
    id: 'email-not-sent-sandbox',
    ask: 'I set up the email alert on Case closure in the UAT sandbox and tested three times. Nothing arrives, not even in spam. What is wrong?',
    findings: [
      'Org kind: sandbox (Partial Copy).',
      'Email alert Case_Closed_Notify exists, sender: current user, template Case_Closed.',
      'The record-triggered flow calling it ran without fault (debug log shows the email alert action executed).',
      'Email deliverability access level in this sandbox: System email only.',
    ],
    must: [/deliverability|system email only/i],
    apt: [EVENTS, WHY],
  },
  {
    id: 'validation-blocks-data-loader',
    ask: 'The finance team cannot load invoices with Data Loader anymore, every row fails with "Invoice date must be in the current quarter". They are loading last quarter on purpose. Can you fix it?',
    findings: [
      'ValidationRule Invoice__c.Invoice_Date_Current_Quarter, active, formula: NOT(ISBLANK(Invoice_Date__c)) && Invoice_Date__c < DATE(YEAR(TODAY()), ...).',
      'The Data Loader runs as the Finance Integration user, profile Finance Integration, permission sets: Finance_Data_Load.',
      'No custom permissions exist in the org.',
    ],
    must: [/custom permission|bypass/i, /validation rule/i],
    apt: [DATA, SECURITY],
  },
  {
    id: 'count-children-via-lookup',
    ask: 'We need a field on Account showing how many open Support Requests it has. Support Request is a custom object with a lookup to Account.',
    findings: [
      'Support_Request__c.Account__c is a Lookup, not master-detail; 41,000 records exist.',
      'No flows exist on Support_Request__c. No roll-up tool is installed (list_installed_packages: b3p only).',
      'Account has 3 roll-up summary fields already, all over Opportunity.',
    ],
    must: [/lookup/i, /master-?detail|roll-?up/i, /flow/i],
    apt: [DATA, FLOWS],
  },
  {
    id: 'callout-on-closed-won',
    ask: 'When an Opportunity is Closed Won we want to post it to our billing system. It has a REST endpoint. What do you propose?',
    findings: [
      'A Named Credential Billing_API exists and is used by nothing.',
      'No Apex exists on Opportunity. One before-save flow exists on Opportunity.',
      'The billing endpoint takes one opportunity per call; retries are idempotent on Opportunity Id.',
    ],
    must: [/named credential/i, /async|after commit|queueable|platform event/i],
    apt: [EVENTS, FLOWS, APEX],
  },
  {
    id: 'new-field-visible-to-sales',
    ask: 'Add a Renewal Date field to Contract and make sure the Sales team can use it.',
    findings: [
      'Contract has no field with "renewal" in its API name or label.',
      'Sales users hold permission set Sales_User; the Contract Layout is the only layout, assigned to all profiles.',
      'Org kind: sandbox.',
    ],
    must: [/permission set/i, /layout|record page/i, /Sales_User|Sales/],
    apt: [NEW_FIELD, DATA],
  },
  {
    id: 'double-email-two-flows',
    ask: 'Customers get two welcome emails when a Contact is created. Find out why and fix it.',
    findings: [
      'Two active after-save flows on Contact create: Contact_Welcome_Email (v2) and Contact_AfterSave_Onboarding (v5). Both contain a Send Email action with the Welcome template.',
      'Contact_AfterSave_Onboarding also assigns the owner and creates a Task; Contact_Welcome_Email does nothing else.',
    ],
    must: [/two (active )?flows|both flows|second flow/i, /one flow|single flow|remove|deactivate|merge|existing flow/i],
    apt: [FLOWS, WHY],
  },
  {
    id: 'rating-changes-overnight',
    ask: 'Account ratings keep changing overnight and nobody in Sales touched them. Where is this coming from?',
    findings: [
      'AccountHistory for three accounts: Rating Warm to Cold at 02:00, CreatedBy Automated Process.',
      'A schedule-triggered flow Account_Nightly_Rating_Review is active, runs daily at 02:00, sets Rating = Cold when LastActivityDate < LAST_N_DAYS:90.',
      'No Apex on Account. b3p package installed; its automation does not touch Rating.',
    ],
    must: [/schedule/i, /Account_Nightly_Rating_Review|nightly/i],
    apt: [WHY, FLOWS],
  },
  {
    id: 'guest-lead-form-owner',
    ask: 'We are replacing Web-to-Lead with a screen flow on the public site so we can ask more questions. Anything I should watch for?',
    findings: [
      'The site guest profile has Create on Lead and Read on Lead; no Edit.',
      'The site default record owner is set to the user "Marketing Queue Owner".',
      'Lead assignment rules are active.',
    ],
    must: [/default (record )?owner|owner/i, /system context|guest sharing|guest/i],
    apt: [SECURITY, FLOWS],
  },
  {
    id: 'flow-to-production-activation',
    ask: 'The Case escalation flow is validated in UAT. Deploy it to production.',
    findings: [
      'Target org: production, protected. The flow file in the workspace has status Active.',
      'Production has flow test coverage requirement off; the flow has no flow tests.',
      'Standing instruction for this org: deploy flows as Draft unless asked.',
    ],
    must: [/draft/i, /activat/i, /confirm/i],
    apt: [OPS, DATA, FLOWS],
  },
  {
    id: 'unable-to-lock-row',
    ask: 'Our nightly import of Order Lines keeps failing with UNABLE_TO_LOCK_ROW on maybe 5% of rows. Why?',
    findings: [
      'Order_Line__c is master-detail to Order__c, which has two roll-up summary fields over lines.',
      'An after-save flow on Order_Line__c updates the parent Order__c Last_Line_Change__c on every insert.',
      'The import runs in parallel batches of 200 through the Bulk API, unsorted by Order.',
    ],
    must: [/lock/i, /parent|Order__c/i, /serial|sort|group|batch/i],
    apt: [WHY, DATA],
  },
  {
    id: 'add-picklist-value',
    ask: 'Add "Partner Referral" to the Lead Source picklist. It should only show on the Partner record type.',
    findings: [
      'Lead.LeadSource uses the global value set Lead_Source (restricted), shared with Contact and Opportunity.',
      'Lead has record types Standard and Partner; the Partner layout is Partner Lead Layout.',
    ],
    must: [/global value set|value set/i, /record type/i],
    apt: [DATA],
  },
  {
    id: 'trigger-recursion',
    ask: 'Our AccountTrigger seems to run twice on every save and sometimes hits the SOQL limit. Can you look?',
    findings: [
      'AccountTrigger (after update) calls AccountService.updateTier(Trigger.new), which updates the same Account records with a new Tier__c.',
      'No static recursion guard exists; there is one SOQL inside a for loop over Trigger.new.',
      'Coverage: AccountServiceTest covers 81%, no bulk test.',
    ],
    must: [/before/i, /recurs|static|guard/i, /loop|bulk/i],
    apt: [APEX],
  },
  {
    id: 'days-until-renewal',
    ask: 'Sales wants to see how many days are left until each Contract renews, on the record and in list views.',
    findings: ['Contract.Renewal_Date__c exists (Date). No field derives from it.', 'Sales users hold permission set Sales_User.'],
    must: [/formula/i, /alternatives considered|skipped|instead of a flow|no flow/i],
    apt: [DATA, NEW_FIELD],
  },
  {
    id: 'guest-edit-own-case',
    ask: 'Customers should be able to update their own Case from the public status page without logging in. Can we give the guest user edit on Case?',
    findings: [
      'The status page is a public Experience site page; visitors are the guest user.',
      'The guest profile currently has Read on Case through guest sharing rules on Case number match.',
    ],
    must: [/cannot|can't|no edit|not allowed|removed|not possible/i, /flow|apex|system context/i, /verif|token|secret|prove|proof|identity|case number/i],
    apt: [SECURITY, FLOWS],
  },
  {
    id: 'email-daily-limit',
    ask: 'Our campaign flow sent emails fine for the first few thousand contacts, then every send failed. What happened?',
    findings: [
      'The flow uses the Send Email action in a loop from a schedule-triggered flow over 12,000 Contacts.',
      'get_org_limits: SingleEmail max 5000, remaining 0.',
      'Fault path output: "SINGLE_EMAIL_LIMIT_EXCEEDED".',
    ],
    must: [/5,?000|daily limit|limit/i, /marketing|mass|batch|tomorrow|spread|Marketing Cloud|Pardot|campaign tool/i],
    apt: [EVENTS, WHY],
  },
  {
    id: 'managed-package-field-change',
    ask: 'The b3p__Score__c formula on Contact gives too much weight to email opens. Change the formula.',
    findings: [
      'b3p__Score__c is a formula field from the installed managed package b3p (3B Platform), version 2.14.',
      'Managed package fields are not editable in this org.',
      'Contact layouts show b3p__Score__c in the Highlights panel.',
    ],
    must: [/managed/i, /cannot|can't|not editable|read-?only|locked/i, /own field|new (formula )?field|custom formula/i],
    apt: [DATA, 'Managed package: <package name> internals'],
  },
  {
    id: 'sandbox-refresh-next-week',
    ask: 'IT is refreshing the UAT sandbox next Tuesday. Anything we need to do first?',
    findings: [
      'The client has a GitHub repository configured for this org; last commit from a session 18 days ago.',
      'The UAT workspace of the current session holds two validated flows not yet committed.',
      'Three flows in UAT are newer than their committed versions (versions 4 and 5 versus committed 3).',
    ],
    must: [/commit|repository|source control|git/i, /lost|overwritten|replaced/i],
    apt: [OPS],
  },
];
