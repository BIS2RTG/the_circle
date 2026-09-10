#!/usr/bin/env bash
#
# setup_github_iso_compliance.sh
#
# Creates ISO 27001 / ISO 22301 compliance milestones and issues in the two
# BIS2RTG repositories (HRIMS and the_circle), covering the "add a new
# module to a live in-house app" compliance roadmap.
#
# PREREQUISITES
#   1. GitHub CLI installed:  https://cli.github.com
#   2. You're logged in and authenticated against BIS2RTG:
#        gh auth login
#        gh auth status
#   3. You have write access to BIS2RTG/HRIMS and BIS2RTG/the_circle.
#
# USAGE
#   chmod +x setup_github_iso_compliance.sh
#   ./setup_github_iso_compliance.sh
#
# WHAT IT DOES
#   For each repo:
#     - Creates 5 milestones (Phase 1..5 of the compliance roadmap)
#     - Creates the issues listed below, each assigned to its milestone
#       and labelled "iso-compliance"
#
# SAFE TO RE-RUN: milestone creation is skipped if a milestone with the
# same title already exists; issues are created fresh each run (gh has no
# built-in dedupe), so don't run this twice unless you've deleted the
# previous issues, or comment out the sections you've already run.
#
set -euo pipefail

# ---- 1. Ensure gh is available and authenticated -------------------------
if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) is not installed. See https://cli.github.com" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

# ---- 2. Helpers ------------------------------------------------------------

# create_milestone <owner/repo> <title> <description>
# Creates a milestone via the REST API (gh has no native `gh milestone` command).
# Skips creation if a milestone with that title already exists; always prints
# the milestone number.
create_milestone() {
  local repo="$1" title="$2" description="$3"
  local existing
  existing=$(gh api "repos/${repo}/milestones?state=all&per_page=100" \
    --jq ".[] | select(.title == \"${title}\") | .number" 2>/dev/null || true)

  if [[ -n "$existing" ]]; then
    echo "  Milestone already exists: \"${title}\" (#${existing})"
    echo "$existing"
    return
  fi

  local number
  number=$(gh api "repos/${repo}/milestones" \
    -f title="${title}" \
    -f description="${description}" \
    -f state="open" \
    --jq '.number')
  echo "  Created milestone: \"${title}\" (#${number})"
  echo "$number"
}

# ensure_label <owner/repo> <label> <color>
ensure_label() {
  local repo="$1" label="$2" color="$3"
  if ! gh label list --repo "$repo" --search "$label" --json name --jq '.[].name' | grep -qx "$label"; then
    gh label create "$label" --repo "$repo" --color "$color" --description "ISO 27001 / ISO 22301 compliance task" >/dev/null 2>&1 || true
  fi
}

# create_issue <owner/repo> <milestone_number> <title> <body>
create_issue() {
  local repo="$1" milestone="$2" title="$3" body="$4"
  gh issue create --repo "$repo" \
    --title "$title" \
    --body "$body" \
    --label "iso-compliance" \
    --milestone "$milestone" >/dev/null
  echo "    + Issue: ${title}"
}

# ---- 3. Milestone definitions (shared across both repos) -----------------
M1_TITLE="ISO Compliance – Phase 1: Baseline & Asset Documentation"
M1_DESC="Establish the missing information-security baseline (asset inventory, architecture/data-flow docs, consolidated documentation) before the new module change is layered on top."

M2_TITLE="ISO Compliance – Phase 2: Change Management & Secure SDLC for New Module"
M2_DESC="Create the forward-looking change record for the new module: business case/change request, risk assessment, SRS sign-off, environment separation evidence, implementation plan."

M3_TITLE="ISO Compliance – Phase 3: Testing, UAT & Rollback Evidence"
M3_DESC="Produce the audit evidence for the module: test plan incl. security testing, executed security tests, UAT sign-off, rollback plan."

M4_TITLE="ISO Compliance – Phase 4: Business Continuity Alignment (ISO 22301)"
M4_DESC="Confirm the module hasn't changed the continuity picture: BIA/RTO/RPO reassessment, backup/recovery confirmation, continuity test decision."

M5_TITLE="ISO Compliance – Phase 5: Audit Readiness & Sign-off"
M5_DESC="Compile the evidence register, run an internal control review, and obtain formal go-live approval."

# ===========================================================================
# REPO 1: BIS2RTG/HRIMS
# ===========================================================================
REPO_HRIMS="BIS2RTG/HRIMS"
echo ""
echo "=== ${REPO_HRIMS} ==="
ensure_label "$REPO_HRIMS" "iso-compliance" "0E8A16"

echo "-- Milestones --"
H_M1=$(create_milestone "$REPO_HRIMS" "$M1_TITLE" "$M1_DESC" | tail -1)
H_M2=$(create_milestone "$REPO_HRIMS" "$M2_TITLE" "$M2_DESC" | tail -1)
H_M3=$(create_milestone "$REPO_HRIMS" "$M3_TITLE" "$M3_DESC" | tail -1)
H_M4=$(create_milestone "$REPO_HRIMS" "$M4_TITLE" "$M4_DESC" | tail -1)
H_M5=$(create_milestone "$REPO_HRIMS" "$M5_TITLE" "$M5_DESC" | tail -1)

echo "-- Issues: Phase 1 --"
create_issue "$REPO_HRIMS" "$H_M1" "Add HRIMS to the ISMS information asset inventory (Control 5.9)" \
"Record HRIMS as an information asset in the ISMS asset register, with a named owner and a description of the personal data categories it holds.

Acceptance criteria:
- [ ] HRIMS entry exists in the asset register with owner assigned
- [ ] Personal data categories held are listed
- [ ] Entry reviewed/approved by the ISMS owner"

create_issue "$REPO_HRIMS" "$H_M1" "Document current HRIMS architecture and data flows" \
"Produce a current-state architecture diagram and data-flow description for HRIMS: what data is held, where it lives (DB/storage), what integrations exist (e.g. hrims-contract-service), and who/what can access it.

Acceptance criteria:
- [ ] Architecture diagram committed to docs/
- [ ] Data flow description covers personal data specifically
- [ ] Reviewed by system owner"

create_issue "$REPO_HRIMS" "$H_M1" "Consolidate and index existing HRIMS documentation" \
"The docs/ folder currently contains a large number of ad-hoc implementation/fix notes with no index or version control. Create a documentation index, archive superseded notes, and identify which documents are 'controlled' (SRS, test plan, etc.) vs informal engineering notes.

Acceptance criteria:
- [ ] docs/README.md index created distinguishing controlled docs from informal notes
- [ ] Superseded/duplicate notes moved to an archive/ folder (already partially in use)
- [ ] Controlled documents identified for Phase 2/3 work"

echo "-- Issues: Phase 2 --"
create_issue "$REPO_HRIMS" "$H_M2" "Draft business case / change request for the new HRIMS module" \
"Document the justification, scope, and expected impact of the new module. This is the forward-looking change record required by Control 8.32 — it must be dated at/before the start of the change, not backfilled after go-live.

Acceptance criteria:
- [ ] Business case / change request document created
- [ ] Reviewed and approved before development proceeds (or retroactively dated and flagged as baseline catch-up if development has already started)"

create_issue "$REPO_HRIMS" "$H_M2" "Conduct risk assessment (incl. data protection) for the new module" \
"Assess security and data-protection risk introduced by the module: new data fields, exports, integrations, or access paths to personal data.

Acceptance criteria:
- [ ] Risk assessment document completed
- [ ] Data protection / privacy impact specifically addressed (Control 5.34)
- [ ] Risks and mitigations signed off by the system owner"

create_issue "$REPO_HRIMS" "$H_M2" "Write/update HRIMS SRS to include the new module and obtain sign-off" \
"Consolidate scattered requirements/implementation notes into a proper Software Requirements Specification covering the new module, and obtain formal sign-off from relevant personnel (matching the practice already used for The Circle's module SRS).

Acceptance criteria:
- [ ] SRS document covers the new module
- [ ] Signed off by BIS/IT Services and the business owner
- [ ] Versioned in docs/"

create_issue "$REPO_HRIMS" "$H_M2" "Confirm and document dev/test/prod environment separation (Control 8.31)" \
"Record evidence that the module was/will be developed and tested outside production, with controlled promotion and access restrictions.

Acceptance criteria:
- [ ] Environment separation documented (what environments exist, who has access to each)
- [ ] Evidence of controlled promotion process (e.g. PR approval, deployment gate)"

create_issue "$REPO_HRIMS" "$H_M2" "Produce implementation plan for the module" \
"Document rollout steps, owners, sequencing, timeline and communication plan for deploying the module to production.

Acceptance criteria:
- [ ] Implementation plan document created
- [ ] Reviewed by relevant stakeholders"

echo "-- Issues: Phase 3 --"
create_issue "$REPO_HRIMS" "$H_M3" "Write test plan covering functional + security testing (Control 8.29)" \
"Produce a controlled test plan for the module, including explicit security test cases (not just functional UAT scenarios).

Acceptance criteria:
- [ ] Test plan document created and covers functional + security scenarios
- [ ] Linked to/consolidates relevant existing *_TESTING_CHECKLIST.md content"

create_issue "$REPO_HRIMS" "$H_M3" "Execute security testing (authN/authZ, RBAC, input validation) and record results" \
"Run and record the results of security-focused testing for the module: authentication, authorisation/RBAC boundaries, and input validation.

Acceptance criteria:
- [ ] Security test execution results recorded
- [ ] Any findings tracked to resolution before go-live"

create_issue "$REPO_HRIMS" "$H_M3" "Create pre-UAT checklist and obtain dated UAT sign-off" \
"Produce a pre-UAT checklist for the module and obtain a dated, named sign-off from the HR/business owner before go-live.

Acceptance criteria:
- [ ] Pre-UAT checklist completed
- [ ] UAT sign-off obtained and recorded with date and signee"

create_issue "$REPO_HRIMS" "$H_M3" "Write rollback plan for the module deployment" \
"Document the fallback procedure if the module deployment fails or needs to be reversed, including data integrity considerations for personal data already affected by the module.

Acceptance criteria:
- [ ] Rollback plan document created
- [ ] Reviewed by system owner"

echo "-- Issues: Phase 4 --"
create_issue "$REPO_HRIMS" "$H_M4" "Reassess business continuity impact of the module on HRIMS (BIA/RTO/RPO)" \
"Update or create a Business Impact Analysis statement for HRIMS reflecting the module: does it change recovery time/point objectives, criticality, or dependencies?

Acceptance criteria:
- [ ] BIA/RTO-RPO statement documented for HRIMS
- [ ] Reviewed against ISO 22301 continuity scope"

create_issue "$REPO_HRIMS" "$H_M4" "Confirm/update HRIMS backup and recovery procedure documentation" \
"If the module changes the data model or storage, confirm backup/recovery procedures still hold and update runbooks accordingly.

Acceptance criteria:
- [ ] Backup/recovery procedure reviewed and, if needed, updated
- [ ] Documented in docs/"

echo "-- Issues: Phase 5 --"
create_issue "$REPO_HRIMS" "$H_M5" "Compile evidence register for the HRIMS module change" \
"Create a single register linking to all approvals, risk assessments, test results, and sign-offs produced in Phases 1-4, mapped to the relevant Annex A controls.

Acceptance criteria:
- [ ] Evidence register created (spreadsheet or markdown table)
- [ ] Every control referenced in the compliance guide has a linked evidence item or explicit N/A"

create_issue "$REPO_HRIMS" "$H_M5" "Internal review against ISO 27001 Annex A controls checklist" \
"Run an internal review of the completed change against the Annex A controls listed in the ISO Compliance Guide (Section 3), before external audit sees it first.

Acceptance criteria:
- [ ] Internal review completed and documented
- [ ] Any gaps found are remediated or have a tracked action"

create_issue "$REPO_HRIMS" "$H_M5" "Obtain formal go-live approval from Head of IT Services & Enterprise Architecture" \
"Obtain and record formal, dated go-live approval before the module is released to production.

Acceptance criteria:
- [ ] Written go-live approval obtained and filed with the evidence register"

# ===========================================================================
# REPO 2: BIS2RTG/the_circle
# ===========================================================================
REPO_CIRCLE="BIS2RTG/the_circle"
echo ""
echo "=== ${REPO_CIRCLE} ==="
ensure_label "$REPO_CIRCLE" "iso-compliance" "0E8A16"

echo "-- Milestones --"
C_M1=$(create_milestone "$REPO_CIRCLE" "$M1_TITLE" "$M1_DESC" | tail -1)
C_M2=$(create_milestone "$REPO_CIRCLE" "$M2_TITLE" "$M2_DESC" | tail -1)
C_M3=$(create_milestone "$REPO_CIRCLE" "$M3_TITLE" "$M3_DESC" | tail -1)
C_M4=$(create_milestone "$REPO_CIRCLE" "$M4_TITLE" "$M4_DESC" | tail -1)
C_M5=$(create_milestone "$REPO_CIRCLE" "$M5_TITLE" "$M5_DESC" | tail -1)

echo "-- Issues: Phase 1 --"
create_issue "$REPO_CIRCLE" "$C_M1" "Version-control and index existing The Circle documentation" \
"Existing docs (Business Case v1.0, SRS, etc.) live as loose .docx files with no visible version history or change log. Establish version control (file naming/versioning convention or a docs changelog) and an index of controlled documents.

Acceptance criteria:
- [ ] Documentation index created in docs/
- [ ] Each controlled document has a version number, date, author, approver
- [ ] Superseded drafts (e.g. ~\$ temp files) removed from the repo"

create_issue "$REPO_CIRCLE" "$C_M1" "Add The Circle to the ISMS information asset inventory (Control 5.9)" \
"Record The Circle as an information asset in the ISMS asset register, with a named owner and description of the approval/audit-trail data it holds."

echo "-- Issues: Phase 2 --"
create_issue "$REPO_CIRCLE" "$C_M2" "Update the Initial Change Request to formally include the new module" \
"The existing change request predates the new module. Update it (or raise a linked follow-on CR) so the module is formally within its documented scope.

Acceptance criteria:
- [ ] Change request updated/extended to cover the module
- [ ] Approved by the relevant change owner"

create_issue "$REPO_CIRCLE" "$C_M2" "Reconcile the two SRS documents (outdated master SRS + signed module SRS)" \
"Merge the signed new-module SRS into a single current, consolidated SRS, resolving what has gone stale in the master document since it was last updated.

Acceptance criteria:
- [ ] Single consolidated SRS produced, versioned
- [ ] Signed off by relevant personnel (module sign-off already exists; carry forward or re-confirm)"

create_issue "$REPO_CIRCLE" "$C_M2" "Update Implementation Plan to include the module rollout" \
"Extend the existing implementation plan with module-specific rollout steps, sequencing and dependencies.

Acceptance criteria:
- [ ] Implementation plan updated
- [ ] Reviewed by stakeholders"

create_issue "$REPO_CIRCLE" "$C_M2" "Confirm environment separation and change-approval evidence (Controls 8.31, 8.32)" \
"Document evidence that the module was developed/tested outside production and promoted through a controlled approval workflow.

Acceptance criteria:
- [ ] Environment separation evidence documented
- [ ] Change approval workflow evidence documented"

echo "-- Issues: Phase 3 --"
create_issue "$REPO_CIRCLE" "$C_M3" "Update Test Plan with module-specific test cases" \
"Extend the existing test plan with test cases for the new module, including approval-workflow correctness and audit-trail integrity checks.

Acceptance criteria:
- [ ] Test plan updated with module test cases
- [ ] Audit-trail/logging integrity explicitly tested (Control 8.15)"

create_issue "$REPO_CIRCLE" "$C_M3" "Update Pre-UAT Checklist for module scenarios and obtain sign-off" \
"Extend the pre-UAT checklist with module scenarios and obtain a current, dated sign-off (confirm the existing sign-off, if any, isn't from before the module existed).

Acceptance criteria:
- [ ] Pre-UAT checklist updated
- [ ] Dated sign-off obtained covering the module"

create_issue "$REPO_CIRCLE" "$C_M3" "Update Rollback Plan to cover the module" \
"Extend the existing rollback plan so it explicitly covers reverting the module without corrupting approval history or the audit trail.

Acceptance criteria:
- [ ] Rollback plan updated
- [ ] Explicitly addresses audit-trail/approval-history integrity on rollback"

create_issue "$REPO_CIRCLE" "$C_M3" "Verify audit-trail and logging integrity for new module actions (Control 8.15)" \
"Confirm actions introduced by the module are correctly and completely captured in The Circle's audit trail, with no gaps or unlogged state transitions.

Acceptance criteria:
- [ ] Logging coverage reviewed for all new module actions
- [ ] Test evidence recorded"

echo "-- Issues: Phase 4 --"
create_issue "$REPO_CIRCLE" "$C_M4" "Assess business continuity impact of the module (BIA update)" \
"Update or create a Business Impact Analysis statement for The Circle reflecting the module's effect on approval-workflow availability and criticality.

Acceptance criteria:
- [ ] BIA/RTO-RPO statement documented for The Circle
- [ ] Reviewed against ISO 22301 continuity scope"

create_issue "$REPO_CIRCLE" "$C_M4" "Confirm digital-approval non-repudiation controls hold with the module (Control 8.24)" \
"Verify that the module doesn't weaken the integrity/non-repudiation of digital approvals (e.g. signature evidence, tamper-evidence of approval records).

Acceptance criteria:
- [ ] Non-repudiation controls reviewed against the module's changes
- [ ] Findings documented"

echo "-- Issues: Phase 5 --"
create_issue "$REPO_CIRCLE" "$C_M5" "Compile evidence register for the module change" \
"Create a single register linking to all approvals, risk assessments, test results, and sign-offs for the module, mapped to the relevant Annex A controls.

Acceptance criteria:
- [ ] Evidence register created
- [ ] Every control referenced in the compliance guide has a linked evidence item or explicit N/A"

create_issue "$REPO_CIRCLE" "$C_M5" "Internal review against ISO 27001 Annex A controls checklist" \
"Run an internal review of the completed change against the Annex A controls listed in the ISO Compliance Guide (Section 3).

Acceptance criteria:
- [ ] Internal review completed and documented
- [ ] Any gaps found are remediated or have a tracked action"

create_issue "$REPO_CIRCLE" "$C_M5" "Obtain formal go-live approval from Head of IT Services & Enterprise Architecture" \
"Obtain and record formal, dated go-live approval before the module is released to production.

Acceptance criteria:
- [ ] Written go-live approval obtained and filed with the evidence register"

echo ""
echo "Done. Review milestones/issues at:"
echo "  https://github.com/${REPO_HRIMS}/milestones"
echo "  https://github.com/${REPO_CIRCLE}/milestones"
