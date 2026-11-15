-- EVE static data (CCP SDE), English only, published types only. Filled by src/sde/import.ts, which swaps whole tables in one transaction.
create table sde_meta (build_number bigint not null, imported_at timestamptz not null default now());

create table sde_types (
  type_id bigint primary key,
  group_id int not null,
  name text not null,
  description text,
  market_group_id int,
  volume double precision,
  packaged_volume double precision,
  mass double precision,
  capacity double precision,
  portion_size int
);
create index sde_types_name on sde_types (lower(name));

create table sde_groups (group_id int primary key, category_id int not null, name text not null);
create table sde_categories (category_id int primary key, name text not null);
create table sde_market_groups (market_group_id int primary key, parent_id int, name text not null);

create table sde_dogma_attributes (attribute_id int primary key, name text not null, display_name text, unit_id int, published boolean not null);
create table sde_units (unit_id int primary key, display_name text);
create table sde_type_attributes (type_id bigint not null, attribute_id int not null, value double precision not null, primary key (type_id, attribute_id));

-- activity: manufacturing, copying, research_material, research_time, invention, reaction
create table sde_blueprints (blueprint_id bigint primary key, max_production_limit int);
create table sde_blueprint_activities (blueprint_id bigint not null, activity text not null, time_seconds int not null, primary key (blueprint_id, activity));
create table sde_blueprint_materials (blueprint_id bigint not null, activity text not null, type_id bigint not null, quantity int not null);
create index sde_blueprint_materials_bp on sde_blueprint_materials (blueprint_id);
create table sde_blueprint_products (blueprint_id bigint not null, activity text not null, type_id bigint not null, quantity int not null, probability double precision);
create index sde_blueprint_products_bp on sde_blueprint_products (blueprint_id);
create index sde_blueprint_products_type on sde_blueprint_products (type_id);
create table sde_blueprint_skills (blueprint_id bigint not null, activity text not null, skill_id bigint not null, level int not null);
create index sde_blueprint_skills_bp on sde_blueprint_skills (blueprint_id);

create table sde_certificates (cert_id int primary key, name text not null);
-- level 1-5 = mastery I-V (SDE keys 0-4)
create table sde_masteries (type_id bigint not null, level int not null, cert_id int not null, primary key (type_id, level, cert_id));
