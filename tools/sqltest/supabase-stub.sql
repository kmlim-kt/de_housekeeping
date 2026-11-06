-- 로컬 테스트 전용: Supabase가 기본 제공하는 auth 스키마·역할·권한을 흉내 냅니다.
-- (실제 Supabase에서는 실행하지 마세요)

create role anon nologin;
create role authenticated nologin;

create schema auth;
create table auth.users (
  id    uuid primary key,
  email text
);

-- Supabase의 auth.uid() / auth.jwt()와 같은 방식으로 JWT 클레임을 읽음
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt()->>'sub', '')::uuid;
$$;

grant usage on schema auth to anon, authenticated;
grant execute on all functions in schema auth to anon, authenticated;

-- Supabase 기본 권한: public 스키마의 새 객체는 anon·authenticated에게 열려 있음 (RLS로 막는 구조)
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables    to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
