import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL
const supabaseKey  = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseKey)

// ── Hulpfunctie: gooit een leesbare fout ──────────────────────────────────────
function check(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

// ── Laad alle data in één keer ────────────────────────────────────────────────
export async function loadAll() {
  const [children, tasks, rewards, redemptions] = await Promise.all([
    supabase.from('children').select('*').order('sort_order'),
    supabase.from('tasks').select('*').order('created_at'),
    supabase.from('rewards').select('*').order('created_at'),
    supabase.from('redemptions').select('*').order('created_at'),
  ])
  check(children,    'loadAll/children')
  check(tasks,       'loadAll/tasks')
  check(rewards,     'loadAll/rewards')
  check(redemptions, 'loadAll/redemptions')

  // Vertaal snake_case → camelCase
  return {
    children:    children.data.map(mapChild),
    tasks:       tasks.data.map(mapTask),
    rewards:     rewards.data.map(mapReward),
    redemptions: redemptions.data.map(mapRedemption),
  }
}

// ── Mappers snake_case → camelCase ────────────────────────────────────────────
export const mapChild       = c => ({ id: c.id, name: c.name, avatar: c.avatar, coins: c.coins, pin: c.pin })
export const mapTask        = t => ({ id: t.id, childId: t.child_id, title: t.title, desc: t.description, coins: t.coins, date: t.date, status: t.status })
export const mapReward      = r => ({ id: r.id, title: r.title, desc: r.description, cost: r.cost, emoji: r.emoji })
export const mapRedemption  = r => ({ id: r.id, childId: r.child_id, rewardId: r.reward_id, rewardTitle: r.reward_title, rewardEmoji: r.reward_emoji, cost: r.cost, date: r.date, status: r.status })

// ── KINDEREN ──────────────────────────────────────────────────────────────────
export async function dbAddChild({ id, name, avatar, coins, pin }) {
  const res = await supabase.from('children').insert({ id, name, avatar, coins: coins ?? 0, pin: pin ?? null }).select().single()
  return mapChild(check(res, 'addChild'))
}

export async function dbDelChild(id) {
  check(await supabase.from('children').delete().eq('id', id), 'delChild')
}

export async function dbUpdateChildCoins(id, coins) {
  check(await supabase.from('children').update({ coins }).eq('id', id), 'updateCoins')
}

// ── TAKEN ─────────────────────────────────────────────────────────────────────
export async function dbAddTask({ id, childId, title, desc, coins, date }) {
  const res = await supabase.from('tasks').insert({
    id, child_id: childId, title, description: desc ?? '', coins, date, status: 'pending'
  }).select().single()
  return mapTask(check(res, 'addTask'))
}

export async function dbDelTask(id) {
  check(await supabase.from('tasks').delete().eq('id', id), 'delTask')
}

export async function dbUpdateTaskStatus(id, status) {
  check(await supabase.from('tasks').update({ status }).eq('id', id), 'updateTaskStatus')
}

// ── BELONINGEN ────────────────────────────────────────────────────────────────
export async function dbAddReward({ id, title, desc, cost, emoji }) {
  const res = await supabase.from('rewards').insert({
    id, title, description: desc ?? '', cost, emoji
  }).select().single()
  return mapReward(check(res, 'addReward'))
}

export async function dbDelReward(id) {
  check(await supabase.from('rewards').delete().eq('id', id), 'delReward')
}

// ── AANVRAGEN ─────────────────────────────────────────────────────────────────
export async function dbAddRedemption({ id, childId, rewardId, rewardTitle, rewardEmoji, cost, date }) {
  const res = await supabase.from('redemptions').insert({
    id, child_id: childId, reward_id: rewardId, reward_title: rewardTitle,
    reward_emoji: rewardEmoji, cost, date, status: 'pending'
  }).select().single()
  return mapRedemption(check(res, 'addRedemption'))
}

export async function dbUpdateRedemptionStatus(id, status) {
  check(await supabase.from('redemptions').update({ status }).eq('id', id), 'updateRedemptionStatus')
}
