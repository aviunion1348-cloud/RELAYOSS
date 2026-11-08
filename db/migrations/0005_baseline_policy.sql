-- ============================================================================
-- Relay OSS · 0005_baseline_policy.sql
-- Baseline governance policy.
--
-- Turnover gates and operational clocks are *policy*, not demo data: the
-- product refuses to certify turnover without them (fail-closed), so they must
-- exist on a freshly migrated database before any seed runs. Idempotent, so it
-- is safe to apply to an environment where the team has already edited policy.
-- ============================================================================

INSERT OR IGNORE INTO turnover_gates (id,key,name,scope,description,required,owner_role,auto_rule) VALUES
  ('tg_t1','TG-01','Owner assigned','task','Every unit of work has exactly one accountable owner.',1,'lead','has_assignee'),
  ('tg_t2','TG-02','Acceptance criteria written','task','Description ≥ 120 characters and checklist items defined.',1,'member','has_description'),
  ('tg_t3','TG-03','Estimated & budgeted','task','Story points set; hours logged within 20% of estimate.',1,'lead','estimate_set'),
  ('tg_t4','TG-04','Peer review approved','task','A second engineer approved the diff — never the author.',1,'lead','review_approved'),
  ('tg_t5','TG-05','Test evidence attached','task','Failing-then-passing evidence, CI link or load-test output.',1,'member','tests_recorded'),
  ('tg_t6','TG-06','No open blockers','task','Dependency chain cleared.',1,'lead',''),
  ('tg_p1','TG-07','Phase acceptance signed','phase','Delivery lead signs the phase acceptance record.',1,'lead',''),
  ('tg_p2','TG-08','Excaliboard link published','phase','Live Excaliboard artefact linked to the phase.',1,'lead','handoff_link'),
  ('tg_p3','TG-09','Client sign-off captured','phase','Written confirmation from the client contact.',1,'admin','client_signoff'),
  ('tg_p4','TG-10','Performance budget verified','phase','Lighthouse / p95 latency within the agreed budget.',1,'lead',''),
  ('tg_p5','TG-11','Docs & runbook updated','phase','ADR, README and runbook reflect the shipped state.',1,'member',''),
  ('tg_p6','TG-12','Retro captured','phase','Three bullets: kept, dropped, tried.',1,'member',''),
  ('tg_x1','TG-13','Launch checklist complete','project','All launch-blocking items closed.',1,'admin',''),
  ('tg_x2','TG-14','Credentials vaulted & transferred','project','Secrets rotated and stored in the client vault.',1,'admin',''),
  ('tg_x3','TG-15','Support runbook approved','project','Severity matrix, escalation and on-call rota documented.',1,'lead','');

INSERT OR IGNORE INTO turnover_gates (id,key,name,scope,description,required,owner_role,auto_rule) VALUES
  ('tg_t7','TG-16','Edge cases catalogued','task','Edge cases for this module are in the ledger before turnover.',1,'member',''),
  ('tg_t8','TG-17','Branch from lear-backend','task','Work branches from the designated project branch and merges back cleanly.',1,'lead','');

INSERT OR IGNORE INTO sla_clocks (id,key,name,scope,anchor_event,target_hours,warn_hours,stretch_hours,enforceable,escalation,policy_note,board_ref) VALUES
  ('ck_consult_plan','consult-to-plan','Consultation → Implementation plan','deal','technical consultation delivered',72,48,36,1,'lead','Maximum 3 days from the first technical consultation to a plan in the client’s inbox.','v1'),
  ('ck_revision','plan-revision','Plan revision after major changes','deal','major change requested',32,24,12,1,'lead','Revisions return within 12–32 hours. 32h is the hard ceiling, 12h the stretch.','v2'),
  ('ck_module','module-turnover','Module turnover','task','module moved to review',24,18,12,1,'lead','A module can never sit in review for more than one day.','v2'),
  ('ck_milestone','milestone-turnover','Milestone turnover','phase','milestone started',168,120,96,1,'lead','A milestone closes inside one week, including QA evidence.','v2'),
  ('ck_client_turn','client-turnover','Client turnover (hard ceiling)','project','phase moved to client review',336,240,168,1,'admin','Two weeks is the absolute ceiling; one week is the target we hold ourselves to.','v3'),
  ('ck_demo','first-demo','First demo','project','project kicked off',336,288,168,1,'lead','The client sees something running within two weeks of kickoff — no exceptions.','v4'),
  ('ck_ship','ship-after-approval','Ship after demo approval','release','demo approved',120,96,48,1,'admin','Once approved, the build ships within five days.','v5'),
  ('ck_qa_report','qa-report','QA report turnover','qa','QA report submitted',12,8,6,1,'lead','Bug and testing reports land within 12 hours of the QA pass.','v6'),
  ('ck_exec','exec-summary','Executive shipping summary','release','release entered demo_ready',96,72,48,1,'admin','The executive summary is prepared at least two days before the proposed shipment.','v6'),
  ('ck_triage','lead-triage','Lead triage of inbound','deal','inbound lead captured',24,12,8,1,'lead','Every inbound gets a qualified or declined answer inside one working day.','v1');

INSERT OR IGNORE INTO sla_policies (id,scope,priority,response_hours,resolve_hours,escalate_to) VALUES
  ('sla_1','task','urgent',1,8,NULL),
  ('sla_2','task','high',4,24,NULL),
  ('sla_3','task','medium',12,72,NULL),
  ('sla_4','task','low',24,168,NULL);

INSERT OR IGNORE INTO retention_policies (id,table_name,retain_days,description) VALUES
  ('ret_activity','activity',400,'Product activity feed retention'),
  ('ret_audit','audit_log',2555,'Audit trail — 7 year regulatory retention'),
  ('ret_notif','notifications',90,'In-app notification retention'),
  ('ret_time','time_entries',2555,'Billable time records');
