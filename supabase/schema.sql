-- schema.sql — PEA Budget บน Supabase (แทน Google Sheet 4 แท็บ ของ Code.gs)
-- วางทั้งไฟล์ใน SQL Editor แล้วกด Run — รันซ้ำได้ ไม่ลบข้อมูล
--
-- หลายสำนักงานอยู่ในโปรเจกต์เดียว แยกด้วยคอลัมน์ office
-- ponytail: ไม่ล็อกอิน (เต้เลือก) → anon อ่าน/เขียนได้ทุกสำนักงาน
--           เปิดล็อกอินวันหน้า = แก้ policy ท้ายไฟล์ให้ผูก office กับผู้ใช้ ไม่ต้องแก้ตาราง

-- ---------- สำนักงาน ----------
create table if not exists offices (
  id          text primary key,            -- รหัสถาวร เช่น kce, kan (ไม่เปลี่ยน)
  name        text not null,               -- ชื่อบนหัวแอป + {OFFICE} บนใบตัด
  file_prefix text not null                -- ตัวนำหน้ารหัสแฟ้ม KCE01 (เปลี่ยนได้จากในแอป)
);

-- ---------- งบ (แท็บ "งบ") ----------
create table if not exists budgets (
  office     text not null references offices(id),
  key        text not null,                -- wbs|network|act
  wbs        text not null default '',     -- ว่างได้ (แฟ้มเก่าที่อ่าน WBS ไม่ได้)
  network    text not null,                -- เก็บเป็น text — Sheets เคยเก็บเป็น number แล้วเทียบพลาด
  dept       text not null default '',
  category   text not null default '',
  act        text not null,                -- '0020' คง leading zero
  allocation numeric(14,2) not null,
  imported   timestamptz not null default now(),
  file_name  text not null default '',
  work_name  text not null default '',
  wbs_total  numeric(14,2),                -- ยอดจัดสรรรวมทั้ง WBS = เพดานตัดจริง; null = ไม่บังคับ
  file_code  text not null default '',     -- KCE## ผูกกับ WBS base
  oper       text not null default '',     -- กฟภ. หรือชื่อบริษัท
  primary key (office, key)
);
create index if not exists budgets_wbs on budgets (office, wbs);

-- ---------- ใบตัด (แท็บ "บันทึกการตัด") ----------
create table if not exists ledger (
  office        text not null,
  slip_no       int  not null,             -- id ภายในสำนักงาน (max+1) — งวดของแฟ้มคำนวณแยก
  key           text not null,
  slip_date     date not null default current_date,
  pay_now       numeric(14,2) not null check (pay_now > 0),
  balance_after numeric(14,2) not null,
  work_name     text not null default '',
  requester     text not null default '',
  position      text not null default '',
  driver        text not null default '',
  contract      text not null default '',  -- สัญญาจ้างที่ = {CON_NO}
  ref           text not null default '',  -- เลขใบสำคัญจ่าย
  user_email    text not null default '',
  ts            timestamptz not null default now(),
  client_id     text unique,               -- กันกดซ้ำ/retry ตัดเบิล
  con_date      date,                      -- ลว.สัญญา
  extra         jsonb not null default '{}',  -- checkbox + ชื่อ/งวด/ทีม/อนุมัติ
  primary key (office, slip_no),
  -- แก้ WBS/โครงข่าย → คีย์ใบตัดตามเอง · ลบงบ → ใบตัดหายตาม (แทน deleteRowsWhere_ ใน GAS)
  foreign key (office, key) references budgets (office, key) on update cascade on delete cascade
);
create index if not exists ledger_key on ledger (office, key);

-- ---------- ประวัติแก้งบ ----------
create table if not exists revisions (
  id      bigserial primary key,
  office  text not null references offices(id),
  key     text not null,                   -- คีย์งบ หรือ WBS เดิม (กรณีแก้ WBS)
  old_val text not null default '',
  new_val text not null default '',
  at      timestamptz not null default now(),
  note    text not null default '',
  by_user text not null default ''
);

-- ---------- ตั้งค่า (พขร./ผู้เบิก/บริษัท/ทะเบียนรถ) ----------
create table if not exists settings (
  office text not null references offices(id),
  type   text not null,
  value  text not null,
  primary key (office, type, value)        -- กันซ้ำแทน apiAddSetting_
);

-- ---------- งบ + ยอดจ่าย/คงเหลือ คำนวณสด (แทน apiGetBudgets_ + paidMap_) ----------
create or replace view budgets_v with (security_invoker = true) as
select b.*,
       coalesce(p.paid, 0)                 as paid,
       b.allocation - coalesce(p.paid, 0)  as balance
from budgets b
left join (select office, key, sum(pay_now) as paid from ledger group by office, key) p
  using (office, key);

-- ---------- เปิดใบตัด: กันเบิกเกินรายหมวด + เพดานทั้งงาน + กันกดซ้ำ (แทน apiCreateSlip_) ----------
-- p = { office, key, payNow, slipDate, workName, requester, position, driver, contract, ref,
--       clientId, conDate, extra }
create or replace function create_slip(p jsonb) returns jsonb
language plpgsql as $$
declare
  b        budgets;
  dup      ledger;
  v_pay    numeric(14,2) := round((p->>'payNow')::numeric, 2);
  v_paid   numeric(14,2);
  v_bal    numeric(14,2);
  v_wpaid  numeric(14,2);
  v_no     int;
begin
  -- ล็อกต่อสำนักงานจนจบ transaction (แทน LockService) — 2 คนกดพร้อมกันจะเข้าทีละคน
  perform pg_advisory_xact_lock(hashtext('slip:' || (p->>'office')));

  if coalesce(p->>'clientId', '') <> '' then
    select * into dup from ledger where client_id = p->>'clientId';
    if found then
      return jsonb_build_object('slipNo', dup.slip_no, 'paid', null,
                                'balance', dup.balance_after, 'duplicate', true);
    end if;
  end if;

  select * into b from budgets where office = p->>'office' and key = p->>'key';
  if not found then raise exception 'ไม่พบก้อนงบ: %', p->>'key'; end if;

  if v_pay is null or v_pay <= 0 then raise exception 'จำนวนเงินต้องมากกว่า 0'; end if;

  select coalesce(sum(pay_now), 0) into v_paid from ledger where office = b.office and key = b.key;
  v_bal := b.allocation - v_paid;
  if v_pay > v_bal then
    raise exception 'เบิกเกินยอดคงเหลือ (คงเหลือ %)', to_char(v_bal, 'FM999999999990.00');
  end if;

  if b.wbs_total is not null then
    select coalesce(sum(l.pay_now), 0) into v_wpaid
      from ledger l join budgets x on x.office = l.office and x.key = l.key
     where x.office = b.office and x.wbs = b.wbs;
    if v_wpaid + v_pay > b.wbs_total then
      raise exception 'ตัดรวมทั้งงานเกินยอดจัดสรรรวม (% บาท) — ตัดได้อีก % บาท',
        to_char(b.wbs_total, 'FM999999999990.00'), to_char(b.wbs_total - v_wpaid, 'FM999999999990.00');
    end if;
  end if;

  select coalesce(max(slip_no), 0) + 1 into v_no from ledger where office = b.office;

  insert into ledger (office, slip_no, key, slip_date, pay_now, balance_after, work_name, requester,
                      position, driver, contract, ref, user_email, client_id, con_date, extra)
  values (b.office, v_no, b.key,
          coalesce(nullif(p->>'slipDate', '')::date, current_date),
          v_pay, v_bal - v_pay,
          coalesce(p->>'workName', ''), coalesce(p->>'requester', ''), coalesce(p->>'position', ''),
          coalesce(p->>'driver', ''), coalesce(p->>'contract', ''), coalesce(p->>'ref', ''),
          coalesce(p->>'userEmail', ''), nullif(p->>'clientId', ''),
          nullif(p->>'conDate', '')::date, coalesce(p->'extra', '{}'::jsonb));

  return jsonb_build_object('slipNo', v_no, 'paid', v_paid + v_pay, 'balance', v_bal - v_pay);
end $$;

-- ---------- สิทธิ์ ----------
grant select, insert, update, delete on offices, budgets, ledger, revisions, settings to anon, authenticated;
grant select on budgets_v to anon, authenticated;
grant usage on sequence revisions_id_seq to anon, authenticated;
grant execute on function create_slip(jsonb) to anon, authenticated;

alter table offices   enable row level security;
alter table budgets   enable row level security;
alter table ledger    enable row level security;
alter table revisions enable row level security;
alter table settings  enable row level security;

-- ponytail: เปิดหมดตามที่เลือกไม่ล็อกอิน — จุดเดียวที่ต้องแก้ถ้าจะผูกสิทธิ์กับสำนักงาน
do $$
declare t text;
begin
  foreach t in array array['offices', 'budgets', 'ledger', 'revisions', 'settings'] loop
    execute format('drop policy if exists open_all on %I', t);
    execute format('create policy open_all on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------- เพิ่มการไฟฟ้าจากในแอปได้ (insert offices ตรง) → กันตัวย่อซ้ำ/รูปแบบผิดฝั่ง server ----------
do $$ begin
  alter table offices add constraint offices_prefix_unique unique (file_prefix);
exception when duplicate_table or duplicate_object then null; end $$;
do $$ begin
  alter table offices add constraint offices_prefix_format check (file_prefix ~ '^[A-Z0-9]{2,5}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table offices add constraint offices_name_nonempty check (btrim(name) <> '');
exception when duplicate_object then null; end $$;

-- ---------- สำนักงานที่ใช้อยู่ ----------
insert into offices (id, name, file_prefix) values
  ('kce', 'กฟส.คำชะอี',    'KCE'),
  ('kan', 'กฟส.กันทรวิชัย', 'KAN')
on conflict (id) do nothing;
