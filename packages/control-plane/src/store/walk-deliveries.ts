/**
 * The link from a walk to what it delivered: a delivery's trigger names the
 * walk's Activity (activity_job). The keep's guards read it
 * (discovery-list-persistence.ts isDiscoveryList, edit-walks.ts walkRunning),
 * and so do the console's review list and its Discovery mark (proposals.ts),
 * a walk's report (walks.ts), the drafts a report names and decide_drafts
 * decides on (slack-thread-reads.ts), list_journeys (journeys-for-job.ts) and
 * decide_drafts (draft-keep-for-job.ts), so these name the same delivery.
 * The keep of a Journey edit still finds an edit walk's delivery by its
 * position in activity_proposal_results (journey-edit-keep.ts lockWalkFinal).
 */
import type postgres from "postgres";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * Whether the proposal aliased `proposal` was delivered by the Activity
 * aliased `activity`, of its own team and Project. Only an activity_job
 * trigger's activityId is read as a uuid, so another trigger's never stops
 * the read; the Activity is found by its primary key.
 */
export function deliveredBy(sql: Queryable, proposal: string, activity: string): postgres.Fragment {
  const delivery = sql(proposal);
  const walk = sql(activity);
  return sql`${walk}.id = (case when ${delivery}.trigger ->> 'source' = 'activity_job' then (${delivery}.trigger ->> 'activityId')::uuid end)
    and ${walk}.team_id = ${delivery}.team_id and ${walk}.project_id = ${delivery}.project_id`;
}

/** The newest delivery of the Activity aliased `activity`, by when it was first delivered; null when it delivered none. */
export function latestDelivery(sql: Queryable, activity: string): postgres.Fragment {
  return sql`(
    select delivery.id from public.proposals delivery
    where ${deliveredBy(sql, "delivery", activity)}
    order by delivery.created_at desc, delivery.id desc limit 1
  )`;
}
