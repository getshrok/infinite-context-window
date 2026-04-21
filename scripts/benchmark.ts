/**
 * Benchmark for @getsaturday/memory — evaluates prompt quality using 5 realistic user profiles.
 * Run: npm run benchmark
 *
 * Runs 5 times and averages to reduce LLM non-determinism.
 * Only modify src/prompts/*.md to improve scores.
 */

import Anthropic from '@anthropic-ai/sdk'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { Memory } from '../src/index.js'
import type { Message, Topic, RetrieveResult } from '../src/index.js'

// ─── LLM setup ────────────────────────────────────────────────────────────────

const apiKey = process.env['ANTHROPIC_API_KEY']
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY not set')
  process.exit(1)
}

const anthropic = new Anthropic({ apiKey })

async function llm(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })
  const block = response.content[0]
  if (!block || block.type !== 'text') throw new Error('unexpected response format')
  return block.text
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-bench-'))
}

async function cleanDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

function findTopicByKeywords(topics: Topic[], keywords: string[]): Topic | null {
  const lower = keywords.map(k => k.toLowerCase())
  let best: Topic | null = null
  let bestScore = 0
  for (const t of topics) {
    const text = `${t.label} ${t.summary} ${t.tags.join(' ')}`.toLowerCase()
    const score = lower.filter(k => text.includes(k)).length
    if (score > bestScore) { bestScore = score; best = t }
  }
  return bestScore > 0 ? best : null
}

function chunksContainText(results: RetrieveResult[], keyword: string): boolean {
  const lower = keyword.toLowerCase()
  for (const r of results) {
    if (r.summary.toLowerCase().includes(lower)) return true
    for (const chunk of r.chunks) {
      if (chunk.summary.toLowerCase().includes(lower)) return true
      for (const msg of chunk.messages) {
        if (msg.content.toLowerCase().includes(lower)) return true
      }
    }
  }
  return false
}

interface QuerySpec {
  query: string
  topicKeywords: string[]
  factKeywords: string[][]  // each sub-array: any keyword match = fact found
  isNegative?: boolean      // true = expect empty results
}

async function scoreProfileQueries(
  mem: Memory,
  allTopics: Topic[],
  queries: QuerySpec[],
  label: string,
): Promise<number> {
  let total = 0
  for (const spec of queries) {
    if (spec.isNegative) {
      const results = await mem.retrieve(spec.query)
      const s = results.length === 0 ? 1.0 : 0.0
      process.stderr.write(`[bench] ${label} negative "${spec.query.slice(0, 40)}": ${s.toFixed(2)}\n`)
      total += s
      continue
    }

    const expectedTopic = spec.topicKeywords.length > 0
      ? findTopicByKeywords(allTopics, spec.topicKeywords)
      : null

    const results = await mem.retrieve(spec.query)

    let topicScore = 0
    if (expectedTopic) {
      const ids = results.map(r => r.topicId)
      if (ids[0] === expectedTopic.topicId) topicScore = 1.0
      else if (ids.includes(expectedTopic.topicId)) topicScore = 0.5
    }

    let factsFound = 0
    for (const group of spec.factKeywords) {
      if (group.some(kw => chunksContainText(results, kw))) factsFound++
    }
    const factScore = spec.factKeywords.length > 0 ? factsFound / spec.factKeywords.length : 1.0

    const s = topicScore * 0.5 + factScore * 0.5
    process.stderr.write(`[bench] ${label} "${spec.query.slice(0, 40)}": topic=${topicScore.toFixed(1)} facts=${factScore.toFixed(2)} => ${s.toFixed(2)}\n`)
    total += s
  }
  return queries.length > 0 ? total / queries.length : 0
}

// ─── Profile 1: Terse Engineer ────────────────────────────────────────────────

const TERSE_S1: Message[] = [
  { role: 'user', content: 'k8s cluster is acting up again' },
  { role: 'assistant', content: 'What are you seeing? Pods failing to schedule, network issues, or something else?' },
  { role: 'user', content: 'pods stuck pending. node pool maxed' },
  { role: 'assistant', content: 'Got it. Are you on GKE or EKS? And is autoscaling enabled on the node pool?' },
  { role: 'user', content: 'eks. autoscaling is on but max is 10 and we\'re at 10' },
  { role: 'assistant', content: 'Easiest fix is bumping the max. Do you want me to look into what\'s consuming the most resources too?' },
  { role: 'user', content: 'yeah bump to 15. also the data pipeline broke overnight' },
  { role: 'assistant', content: 'On it for the node pool. What pipeline — the Spark ETL or the Airflow DAGs?' },
  { role: 'user', content: 'airflow. the dbt transform step timed out' },
  { role: 'assistant', content: 'Was it the incremental model or the full refresh? Those have very different runtime profiles.' },
  { role: 'user', content: 'incremental. stg_orders model. been slow since we added that join to inventory' },
  { role: 'assistant', content: 'That join is probably doing a full scan on the inventory table. Worth checking if there\'s an index on the join key.' },
  { role: 'user', content: 'good call. also remind me to renew the ssl cert on api.internal by friday' },
  { role: 'assistant', content: 'Noted — SSL cert renewal for api.internal by Friday. Want me to check the expiry date to confirm the urgency?' },
  { role: 'user', content: 'nah i know its the 21st. just dont let me forget' },
  { role: 'assistant', content: 'Will remind you Thursday.' },
  { role: 'user', content: 'btw the postgres migration to rds. we decided on db.r6g.xlarge right?' },
  { role: 'assistant', content: 'I don\'t have a record of that decision yet. Is that what you\'re going with?' },
  { role: 'user', content: 'yeah. 4vcpu 32gb. should handle our workload. cutover is april 5' },
  { role: 'assistant', content: 'Logged. db.r6g.xlarge, cutover April 5. Want me to track any prep tasks for that?' },
  { role: 'user', content: 'not yet. gotta figure out the replication lag tolerance first' },
]

const TERSE_S2: Message[] = [
  { role: 'user', content: 'fixed the stg_orders thing. added idx on inventory.sku_id' },
  { role: 'assistant', content: 'Nice. How\'s the runtime now?' },
  { role: 'user', content: 'down from 45min to 3min' },
  { role: 'assistant', content: 'Massive improvement. Worth adding that index to the dbt post-hooks so it survives full refreshes.' },
  { role: 'user', content: 'already did. also gh actions is broken on the api repo' },
  { role: 'assistant', content: 'What\'s failing? Build step, tests, or deployment?' },
  { role: 'user', content: 'tests. jest is OOMing on the integration suite' },
  { role: 'assistant', content: 'Are you running them in parallel? Jest\'s default worker count can eat memory fast. Try --maxWorkers=2 or --runInBand for the integration tests.' },
  { role: 'user', content: 'runInBand fixed it. slow but at least it passes. will optimize later' },
  { role: 'assistant', content: 'Could also split integration tests into their own workflow with a bigger runner. But yeah, later.' },
  { role: 'user', content: 'on the rds migration. what was the instance we picked' },
  { role: 'assistant', content: 'db.r6g.xlarge — 4 vCPU, 32GB. Cutover April 5.' },
  { role: 'user', content: 'right. so i talked to devops and we\'re going with 100ms replication lag tolerance' },
  { role: 'assistant', content: 'That\'s tight but doable with RDS read replicas. Are you planning a blue-green cutover or just a maintenance window?' },
  { role: 'user', content: 'maintenance window. saturday night april 5. 2am-6am' },
  { role: 'assistant', content: 'Got it. Four-hour window, April 5 2-6am. Want me to draft a checklist for the migration steps?' },
  { role: 'user', content: 'yeah actually do that. separate task tho not now' },
  { role: 'assistant', content: 'Will do.' },
  { role: 'user', content: 'also we\'re hiring a senior backend eng. can you help me write the jd later' },
  { role: 'assistant', content: 'Sure. What stack should I focus on — the Go services or the Node stuff?' },
  { role: 'user', content: 'go primarily. need someone who knows grpc and can own the billing service' },
  { role: 'assistant', content: 'Got it. Senior Go engineer, gRPC experience, billing domain. I\'ll have a draft ready when you want it.' },
]

const TERSE_S3: Message[] = [
  { role: 'user', content: 'ssl cert. is that tomorrow' },
  { role: 'assistant', content: 'Yes — api.internal cert expires March 21. Tomorrow is the 20th so you\'ve got one more day, but probably best to handle it tomorrow.' },
  { role: 'user', content: 'k ill do it first thing. certbot right?' },
  { role: 'assistant', content: 'If you\'re using Let\'s Encrypt, yeah. certbot renew --cert-name api.internal should do it. If it\'s an internal CA cert the process is different.' },
  { role: 'user', content: 'internal ca. ill just regenerate from vault' },
  { role: 'assistant', content: 'Makes sense. vault write pki/issue/api-internal common_name=api.internal ttl=8760h if you want a year.' },
  { role: 'user', content: 'thx. hows the migration checklist coming' },
  { role: 'assistant', content: 'Haven\'t started it yet — you said separate task. Want me to do it now?' },
  { role: 'user', content: 'yeah go for it. worried about the timeline tbh' },
  { role: 'assistant', content: 'What\'s the concern — the April 5 window itself or the prep work leading up to it?' },
  { role: 'user', content: 'prep. we\'re short staffed and i\'m doing too much myself' },
  { role: 'assistant', content: 'That connects to the hiring. Any chance of getting a contractor in the short term to help with migration prep?' },
  { role: 'user', content: 'maybe. but onboarding takes time too. might just push through' },
  { role: 'assistant', content: 'If you\'re going to push through, let me take as much off your plate as I can. I\'ll draft the migration checklist tonight and the job description. You review tomorrow.' },
  { role: 'user', content: 'appreciate that. honestly been running on fumes this week' },
  { role: 'assistant', content: 'I can tell. You\'ve been context-switching between five different fires. Once the cert is renewed and the migration checklist exists, the path to April 5 gets clearer.' },
  { role: 'user', content: 'yeah. need to learn to delegate more. thats why the hire matters' },
  { role: 'assistant', content: 'Exactly. Get someone in who can own billing and that\'s one less thing on your plate permanently. I\'ll make the JD compelling.' },
  { role: 'user', content: 'cool. going to log off. early morning tomorrow' },
  { role: 'assistant', content: 'Get some rest. I\'ll have the checklist and JD ready for you in the morning.' },
]

// ─── Profile 2: Scatterbrained (Jamie) ───────────────────────────────────────

const SCATTER_S1: Message[] = [
  { role: 'user', content: 'hey so i was thinking about finally switching to linux on my desktop but also did you ever look into that protein powder i mentioned' },
  { role: 'assistant', content: 'I don\'t think you\'ve mentioned protein powder before — that might be new! As for Linux, what\'s drawing you to switch? Are you on Windows right now?' },
  { role: 'user', content: 'oh wait maybe that was someone else lol. yeah windows 11 and it\'s driving me crazy with the ads in the start menu. i was looking at fedora or maybe pop os' },
  { role: 'assistant', content: 'Pop!_OS is great for someone coming from Windows — very polished out of the box. Fedora is solid too but a bit more hands-on. What do you mainly use your desktop for?' },
  { role: 'user', content: 'gaming mostly and some blender stuff. oh speaking of which my 3d print of that dragon finally finished but one of the wings broke off' },
  { role: 'assistant', content: 'Nice! For the broken wing, super glue usually works for PLA, or you could reprint just the wing if you have the STL split. For gaming on Linux, Pop!_OS has better Nvidia driver support out of the box if you have an Nvidia card.' },
  { role: 'user', content: 'yeah i have a 4070. ok wait i just remembered i need to book flights for my sister\'s wedding in june. its in savannah. do you know if allegiant flies there' },
  { role: 'assistant', content: 'Allegiant does fly to Savannah-Hilton Head (SAV) from some airports, but it depends on where you\'re flying from. When in June is the wedding?' },
  { role: 'user', content: 'june 14th. flying from rochester ny. honestly might just drive it\'s like 13 hours' },
  { role: 'assistant', content: '13 hours is a haul. You could also check if there\'s a cheap connecting flight through Charlotte or Atlanta — sometimes those are under $200 round trip from ROC. Want me to look into it?' },
  { role: 'user', content: 'yeah that\'d be cool. oh also random but i think my cat might have a UTI she\'s been going to the litter box a lot. is that a thing' },
  { role: 'assistant', content: 'Yes, frequent litter box trips is a classic UTI sign in cats, especially if she\'s straining or only producing small amounts. I\'d get her to the vet soon — UTIs can escalate quickly in cats. Is she eating and drinking normally otherwise?' },
  { role: 'user', content: 'she seems fine otherwise yeah. her name is Beans btw. ok going back to the linux thing — can i run blender on pop os without issues' },
  { role: 'assistant', content: 'Blender runs great on Pop!_OS — it\'s well supported on Linux in general. With your 4070 you\'d get full CUDA support for GPU rendering too. The main thing to watch is making sure you install the Nvidia driver version that matches your card, but Pop!_OS has a dedicated Nvidia ISO that handles this automatically.' },
]

const SCATTER_S2: Message[] = [
  { role: 'user', content: 'update on beans — vet says its definitely a uti. she\'s on antibiotics now' },
  { role: 'assistant', content: 'Glad you got her in quickly. Antibiotics should clear it up within a week or so. Make sure she\'s drinking plenty of water — you can try adding a little water to her wet food if she\'s not a big drinker.' },
  { role: 'user', content: 'yeah she only eats dry food which the vet said is probably part of the problem. gonna try switching her to wet' },
  { role: 'assistant', content: 'That\'s a smart move. Wet food has way more moisture content. Some cats resist the switch though — you can mix a little wet into the dry and gradually increase the ratio over a week or two.' },
  { role: 'user', content: 'ok cool. hey did you ever look up flights for savannah' },
  { role: 'assistant', content: 'I haven\'t yet — want me to check now? You said June 14th from Rochester, right? How many days would you want to be there?' },
  { role: 'user', content: 'actually the wedding is the 15th i messed up. probably fly in the 13th and leave the 17th. oh and my girlfriend is coming too so two tickets' },
  { role: 'assistant', content: 'Got it — two tickets, ROC to SAV, June 13-17. I\'ll look into options. Direct flights from Rochester to Savannah are rare so you\'ll likely be looking at one connection.' },
  { role: 'user', content: 'that\'s fine. hey completely unrelated but i\'ve been trying to get into running and my knees are killing me. i\'m running on pavement should i switch to trails' },
  { role: 'assistant', content: 'Trails are easier on joints for sure — softer surface, less repetitive impact. But knee pain when starting running is usually more about shoes and form than surface. Are you in actual running shoes or just general sneakers?' },
  { role: 'user', content: 'just some old nikes honestly' },
  { role: 'assistant', content: 'That\'s probably your biggest issue. Get fitted at a running store — they\'ll watch your gait and recommend shoes with the right support. It makes a massive difference, especially for knee pain. Budget around $120-150 for a decent pair.' },
  { role: 'user', content: 'ugh ok. i also need to figure out a gift for the wedding. my sister is impossible to shop for. she\'s really into ceramics lately if that helps' },
  { role: 'assistant', content: 'If she\'s into ceramics, you could look at a gift card or class package from a local pottery studio in Savannah — there are some great ones there. Or commission a custom piece from a ceramicist. More personal than a registry item.' },
  { role: 'user', content: 'oh thats actually a great idea. ok i gotta run but remind me to actually order running shoes this week' },
  { role: 'assistant', content: 'Will do. Hope Beans feels better soon!' },
]

const SCATTER_S3: Message[] = [
  { role: 'user', content: 'so i installed pop os on an extra ssd and its actually pretty nice' },
  { role: 'assistant', content: 'Nice! Smart move doing it on a separate SSD so you can dual-boot. Did the Nvidia drivers work out of the box?' },
  { role: 'user', content: 'yeah used the nvidia iso and everything just worked. blender runs fine too. only problem is steam — half my games don\'t launch' },
  { role: 'assistant', content: 'Make sure you enable Steam Play for all titles in Steam settings — that turns on Proton for Windows games. Also check ProtonDB for your specific games to see which Proton version works best. Some games need specific launch options.' },
  { role: 'user', content: 'oh i didn\'t do the steam play thing let me try that. hey did i tell you beans is doing way better on the antibiotics' },
  { role: 'assistant', content: 'That\'s great to hear! Has she taken to the wet food at all?' },
  { role: 'user', content: 'kinda. she eats it if i mix it in but won\'t eat it straight. progress i guess' },
  { role: 'assistant', content: 'That\'s actually good progress for a cat that was on dry food only. Keep gradually increasing the ratio. Some cats take a few weeks to fully switch.' },
  { role: 'user', content: 'oh hey i forgot to buy running shoes. also i changed my mind about running i think im gonna do cycling instead. my buddy has an extra road bike he\'ll sell me for 400' },
  { role: 'assistant', content: 'Cycling is way easier on the knees — good call given the issues you were having. $400 for a road bike from a buddy is usually a solid deal. Do you know what brand/model it is?' },
  { role: 'user', content: 'some trek something i forget. it\'s like 3 years old. he barely rode it lol' },
  { role: 'assistant', content: 'A 3-year-old barely-ridden Trek for $400 is a great deal. Just make sure the tires aren\'t dry-rotted from sitting — that\'s the main thing with bikes that have been stored. New tires are cheap though.' },
  { role: 'user', content: 'good tip. ok im gonna go try to get elden ring working on linux wish me luck' },
  { role: 'assistant', content: 'Elden Ring works well on Proton — check ProtonDB for the recommended version. GE-Proton usually has the best compatibility. Good luck!' },
]

const SCATTER_S4: Message[] = [
  { role: 'user', content: 'ok so elden ring works perfectly on linux im never going back to windows' },
  { role: 'assistant', content: 'Ha, that\'s usually how it goes once gaming works. Are you fully on Pop!_OS now or still dual-booting?' },
  { role: 'user', content: 'still dual booting but i haven\'t booted windows in 5 days so. hey random question — that ceramics gift idea for my sister. you said i could find a pottery studio in savannah right? can you actually find one' },
  { role: 'assistant', content: 'Sure! There are several in Savannah — Sulfur Studios and Savannah Clay Community are both well-regarded and offer classes and workshops. Want me to look into whether they do gift certificates?' },
  { role: 'user', content: 'yeah that\'d be perfect. she can do it while she\'s living there. oh also i bought the bike from marcus' },
  { role: 'assistant', content: 'Nice! How\'s it ride? And good to know your sister lives in Savannah — that makes the pottery studio gift even better since she can actually use it regularly, not just during the wedding trip.' },
  { role: 'user', content: 'haven\'t ridden it yet lol it\'s been raining all week. and yeah she moved there like two years ago for work she does something in hospitality management' },
  { role: 'assistant', content: 'Makes sense — Savannah has a huge hospitality industry with all the tourism. Let me know when you get a dry day to take the Trek out. Check the tire pressure before your first ride since it\'s been sitting.' },
  { role: 'user', content: 'will do. oh i keep forgetting to ask — my 3d print of the dragon that broke, is there a way to just print the wing separately? the model is one piece' },
  { role: 'assistant', content: 'Yeah — you can cut the model in a slicer like Meshmixer or even in your slicer software. Import the full STL, use a plane cut to isolate just the wing, export that piece, and print it. Then glue it to the existing body. What slicer are you using?' },
  { role: 'user', content: 'cura. ok let me try that this weekend. beans says hi btw she\'s sitting on my keyboard' },
  { role: 'assistant', content: 'Hi Beans! Classic cat move. Is she all done with the antibiotics?' },
  { role: 'user', content: 'two more days. she\'s totally back to normal though' },
  { role: 'assistant', content: 'Great — make sure she finishes the full course even though she seems better. Stopping early is how you get resistant bacteria.' },
]

const SCATTER_S5: Message[] = [
  { role: 'user', content: 'hey so update on everything i guess. fully on linux now i wiped windows. beans is 100% healthy. and i finally rode the bike yesterday' },
  { role: 'assistant', content: 'Big moves all around! How was the ride? And bold move wiping Windows entirely.' },
  { role: 'user', content: 'ride was great but my legs are dead today lol. i did like 15 miles on the canal trail. and yeah windows can kick rocks honestly the only thing i miss is like adobe stuff' },
  { role: 'assistant', content: '15 miles on your first ride is solid — your legs will adapt fast. For Adobe alternatives on Linux, GIMP and Inkscape cover a lot of ground. If you need Photoshop specifically, it runs okay through Wine or you could keep a Windows VM just for Adobe.' },
  { role: 'user', content: 'i mostly use photoshop for texturing my 3d prints so gimp might work actually. oh speaking of which i printed the wing separately and it came out perfect. used meshmixer like you said' },
  { role: 'assistant', content: 'Nice! Did the glue hold up well? And yeah GIMP should be fine for texturing work — the UV unwrap workflow is a bit different but the core painting tools are solid.' },
  { role: 'user', content: 'used gorilla glue and you can barely see the seam. hey have you found anything on those savannah flights yet i keep forgetting to ask' },
  { role: 'assistant', content: 'I haven\'t searched yet — let me do that now. Just to confirm: two tickets, Rochester to Savannah, June 13th to 17th, you and your girlfriend?' },
  { role: 'user', content: 'actually make it the 12th to 17th. we wanna have a day to explore before the wedding craziness starts. oh and her name is Taylor if that matters for booking' },
  { role: 'assistant', content: 'Got it — June 12-17, two passengers, Jamie and Taylor, ROC to SAV. I\'ll look into options. The extra day is a good call — Savannah\'s historic district is beautiful and very walkable.' },
  { role: 'user', content: 'yeah taylor\'s never been. we should find some good restaurants too while we\'re there. she\'s vegetarian btw if that matters for savannah food recs' },
  { role: 'assistant', content: 'Savannah has great vegetarian options — Fox & Fig is an all-vegan spot that\'s really popular, and Henny Penny Art Space & Cafe has good veggie stuff. I can put together a list closer to the trip.' },
  { role: 'user', content: 'perfect. ok im gonna go ice my legs lol. cycling is no joke' },
  { role: 'assistant', content: 'Ha — it gets easier fast. Try to ride 2-3 times a week and your legs will stop complaining within a couple weeks. Enjoy the soreness, it means you did something!' },
]

// ─── Profile 3: Life Transition (Jordan) ─────────────────────────────────────

const LIFE_S1: Message[] = [
  { role: 'user', content: 'hey, rough day. got the official severance paperwork today and it\'s only 6 weeks. I was expecting at least 3 months based on what they told me verbally' },
  { role: 'assistant', content: 'That\'s a big gap between what you were told and what showed up on paper. Six weeks is tight. Have you had a chance to look through the full terms yet, or did it just land today?' },
  { role: 'user', content: 'just landed. I skimmed it. there\'s a non-compete clause that I definitely need to look at because if they\'re going to limit where I can work AND only give me 6 weeks that\'s insane' },
  { role: 'assistant', content: 'Yeah, a non-compete on top of reduced severance is worth pushing back on. Did they give you a deadline to sign? Sometimes there\'s a negotiation window, especially if the verbal promise was different.' },
  { role: 'user', content: '21 days to sign. Sam thinks I should just sign it and move on but I think that\'s because the money stress is getting to both of us. we had a fight about it already' },
  { role: 'assistant', content: 'That\'s a lot hitting at once — the severance disappointment, the legal stuff, and the pressure at home. The 21 days is actually decent breathing room. You don\'t have to decide tonight.' },
  { role: 'user', content: 'yeah. I think Sam is scared because we only have about 4 months of savings and the mortgage is $2,800/mo. plus insurance runs out end of april if I sign the severance as-is' },
  { role: 'assistant', content: 'So the real timeline is insurance-driven — end of April is barely five weeks out. That puts the COBRA decision and the severance negotiation on the same clock. Have you looked at what COBRA would cost to extend coverage?' },
  { role: 'user', content: 'no not yet. honestly I spent most of today just kind of sitting there. applied to two jobs on linkedin but my heart wasn\'t in it. one was a PM role at stripe and one was at some Series B I\'ve never heard of' },
  { role: 'assistant', content: 'Applying to anything on a day like today counts. Stripe would be a strong fit given your background. What was the Series B?' },
  { role: 'user', content: 'called Trellis, they do something with supply chain AI. the job description was fine but I read it and just felt nothing. I keep thinking maybe I don\'t want to do product management anymore' },
  { role: 'assistant', content: 'That\'s worth sitting with rather than pushing away. Is that a new feeling or something that\'s been building?' },
  { role: 'user', content: 'building for at least a year honestly. I used to love the customer side of PM but the last two years were all stakeholder management and roadmap politics. I miss making things. I\'ve been messing around with woodworking on weekends and it\'s the only time I feel like myself' },
  { role: 'assistant', content: 'That\'s a real signal — when the side thing is where you feel most like yourself and the main thing has been draining for a year. Doesn\'t mean you need to become a woodworker tomorrow, but it\'s worth factoring in as you think about what\'s next.' },
  { role: 'user', content: 'Sam would lose it if I said I wanted to do woodworking instead of job hunting lol. we\'re not in a position for that. but maybe there\'s something in between' },
]

const LIFE_S2: Message[] = [
  { role: 'user', content: 'got a recruiter message about a PM lead role at Datadog. salary range looks good, 195-225. I should be excited but I feel dread' },
  { role: 'assistant', content: 'Dread is information. Is it dread about the interview process, about going back to PM, or about something else?' },
  { role: 'user', content: 'about going back to PM. like the money would solve everything — Sam would relax, mortgage is covered, insurance is covered. but I\'d be right back where I was' },
  { role: 'assistant', content: 'The financial relief is real and immediate. The career satisfaction question is real but slower. Those are two different timelines pulling in different directions.' },
  { role: 'user', content: 'exactly. and Sam and I actually had a better conversation last night. I told them about the woodworking thing and they didn\'t freak out. they said they get it but we need a plan that doesn\'t involve burning through savings while I "find myself"' },
  { role: 'assistant', content: 'That sounds like a much more productive conversation than the fight earlier in the week. Sam\'s framing is reasonable too — it\'s not a no, it\'s a "show me the plan."' },
  { role: 'user', content: 'yeah. so I\'ve been thinking. what if I take a PM contract role — 3 or 6 months — to cover the bills and buy time, and use evenings and weekends to actually explore the woodworking thing seriously. like take a furniture making class, build some pieces, see if there\'s a business there' },
  { role: 'assistant', content: 'That\'s a solid middle path. Contract PM pays well, usually no non-compete issues, and it has a built-in end date so you\'re not committing to another full-time PM career. Have you looked at what the contract market looks like right now?' },
  { role: 'user', content: 'not yet. I know Toptal and a couple others. also I have a friend Maya who does contract product work, I should ask her how she set it up' },
  { role: 'assistant', content: 'Maya would be the best source — she\'s already navigated the exact transition from full-time to contract. That conversation is probably worth more than any job board research.' },
  { role: 'user', content: 'true. oh also I looked up COBRA and it\'s $1,840/month for both of us. insane. Sam\'s job doesn\'t offer insurance — they\'re freelance. so I need to figure out the marketplace alternative too' },
  { role: 'assistant', content: '$1,840 is brutal. The ACA marketplace would be significantly cheaper, especially if your income is lower this year due to the layoff. You\'d qualify for subsidies based on projected annual income. Worth running the numbers on healthcare.gov.' },
  { role: 'user', content: 'ok I\'ll look at that this weekend. this is the first time in a few days I feel like I have a direction instead of just spinning' },
]

const LIFE_S3: Message[] = [
  { role: 'user', content: 'update: I talked to Maya. she said contract PM rates are between 150-200/hr depending on the company and she gets most of her work through her network not platforms. she\'s going to intro me to two people' },
  { role: 'assistant', content: 'That\'s great. $150-200/hr contract work would more than cover your monthly burn even at part-time hours. Did she say how long it took her to land her first contract?' },
  { role: 'user', content: 'about 3 weeks from when she started seriously looking. she also said the non-compete in my severance probably isn\'t enforceable for contract work but I should have a lawyer look at it' },
  { role: 'assistant', content: 'Smart advice. An employment lawyer could review it for a flat fee — usually a few hundred dollars — and give you clarity on what you can and can\'t do. Worth it given the stakes.' },
  { role: 'user', content: 'yeah I actually found one through Sam\'s cousin. consultation is thursday. I also signed up for a 6-week furniture making class at the community college. starts april 5th, tuesday and thursday evenings, $280' },
  { role: 'assistant', content: 'You\'re moving on both tracks. That\'s exactly the plan you described to Sam — contract work for stability, woodworking class to explore the other path. How did Sam react to the class?' },
  { role: 'user', content: 'they were actually into it. I think the contract PM plan made them feel safe enough to be supportive about the woodworking. like once the money fear was addressed they could be excited with me' },
  { role: 'assistant', content: 'That tracks with what you said before — Sam\'s concern was never about the dream itself, it was about the financial risk. Removing the risk unlocked the support.' },
  { role: 'user', content: 'exactly. oh and I heard back from Stripe — they want to do a phone screen. I\'m torn. it\'s full-time PM which is what I\'m trying to get away from but it\'s Stripe' },
  { role: 'assistant', content: 'It\'s worth doing the phone screen even if you\'re leaning toward the contract path. It\'s information — you learn what they\'re offering, what the role actually looks like, and you\'re not committing to anything by talking. It also keeps your interviewing skills sharp.' },
  { role: 'user', content: 'fair point. ok I\'ll do it. worst case it\'s practice. I just don\'t want to get sucked into a great offer and abandon the plan before I even try it' },
  { role: 'assistant', content: 'That\'s a real risk and good to name out loud. You could set a decision rule for yourself now — like, unless Stripe offers something dramatically different from standard PM (maybe a maker-oriented role, or a limited engagement), the contract path stays the plan.' },
  { role: 'user', content: 'I like that. the decision rule. ok: unless it\'s something that genuinely excites me, not just financially good, I stick with contract + woodworking. I\'ll write that down' },
]

const LIFE_S4: Message[] = [
  { role: 'user', content: 'lawyer says the non-compete is narrow enough that contract work for a different industry vertical is fine. she also said the severance is negotiable and I should counter for 10 weeks' },
  { role: 'assistant', content: 'That\'s two big wins — the non-compete isn\'t blocking contract work, and there\'s room to push on severance. Are you going to counter?' },
  { role: 'user', content: 'yeah I sent the counter today. asked for 10 weeks and removal of the non-compete entirely. lawyer helped me draft it. feeling weirdly empowered' },
  { role: 'assistant', content: 'That\'s not weird at all — you went from feeling blindsided by the severance to actively negotiating it. That\'s agency. Did the Stripe phone screen happen?' },
  { role: 'user', content: 'yeah, yesterday. it was fine. the role is basically what I expected — senior PM on their billing platform. good team, good money. but I felt nothing. like zero spark. so the decision rule holds' },
  { role: 'assistant', content: 'The decision rule did its job. You gave it a fair shot, confirmed it\'s not the path, and can move forward without wondering what-if.' },
  { role: 'user', content: 'yeah. Maya\'s intros came through though. I have coffee with a guy named Derek next week who runs product consulting and needs contractors. and another call with a fintech startup that wants a 3-month PM engagement' },
  { role: 'assistant', content: 'Two real leads from Maya\'s network. The 3-month fintech engagement especially fits your plan — defined timeline, income, and you keep the evenings free for the furniture class.' },
  { role: 'user', content: 'exactly what I was thinking. furniture class starts friday actually, not the 5th like I originally thought — they moved it up. I bought some basic tools. Sam helped me set up a workspace in the garage. it\'s small but it\'s mine' },
  { role: 'assistant', content: 'Sam helping set up the garage workspace is a good sign — they\'re invested in this with you, not just tolerating it. How are things between you two generally? The money stress was heavy a couple weeks ago.' },
  { role: 'user', content: 'so much better. I think having a plan changed everything. we\'re not fighting about money anymore. we\'re actually talking about what we want our life to look like, not just surviving. Sam even said maybe they\'d want to sell some of my pieces on their etsy shop if I get good enough' },
  { role: 'assistant', content: 'That\'s a complete shift from where you were two weeks ago. You went from a fight about signing the severance to a shared vision with a garage workshop and an Etsy plan. The plan didn\'t just fix the money anxiety — it gave you both something to build toward together.' },
]

// ─── Profile 4: Professional (fintech EM) ────────────────────────────────────

const PROF_S1: Message[] = [
  { role: 'user', content: 'Morning. Two things I need to sort out this week.' },
  { role: 'assistant', content: 'Good morning. What\'s on the list?' },
  { role: 'user', content: 'First, the payment gateway migration. We\'re moving from Stripe Connect to a direct Stripe integration. The team started last sprint but we hit issues with the webhook handling — events are arriving out of order and our idempotency logic doesn\'t account for that.' },
  { role: 'assistant', content: 'What\'s the current approach to idempotency? Are you keying on the event ID or something else?' },
  { role: 'user', content: 'Event ID, but the problem is we process payment_intent.succeeded before charge.captured sometimes, and our handler assumes they arrive in order. Marcus is looking at adding a state machine per payment but I\'m not sure that\'s the right call — adds a lot of complexity.' },
  { role: 'assistant', content: 'A lightweight state machine could work if you keep it simple — just track which events you\'ve seen per payment intent and only process transitions when all prerequisites are met. The alternative is a short delay queue where you buffer events for a few seconds and process them in order, which is simpler but adds latency.' },
  { role: 'user', content: 'The delay queue is interesting. We can tolerate 5-10 seconds of latency on webhook processing. I\'ll bring that to Marcus and Priya in the standup.' },
  { role: 'assistant', content: 'Good call. What\'s the second thing?' },
  { role: 'user', content: 'The Q3 capacity planning doc. Leadership wants it by Thursday. I need to estimate headcount for two scenarios — one where we take on the risk engine project and one where we don\'t. The risk engine would need 2 senior backend engineers and a data scientist. Without it we\'re fine with current team.' },
  { role: 'assistant', content: 'Do you have the current team allocation mapped out already, or do you need to start from scratch?' },
  { role: 'user', content: 'I have a rough spreadsheet from Q2 planning. It\'s mostly accurate but Elena moved to the fraud team in April and we hired Jun in May, so those two changes need to be reflected. I\'ll update the spreadsheet today and then work on the narrative sections tomorrow.' },
  { role: 'assistant', content: 'Makes sense. Want me to draft an outline for the narrative sections based on what you\'ve described?' },
  { role: 'user', content: 'That would be great, but let me update the numbers first so the outline is grounded in the actual data. I\'ll circle back on this tomorrow.' },
  { role: 'assistant', content: 'Sounds good. Payment gateway webhook issue and Q3 capacity doc — I\'ll remember both. Talk tomorrow.' },
]

const PROF_S2: Message[] = [
  { role: 'user', content: 'Update on the webhook issue. Marcus and I went with the delay queue approach. He\'s implementing it with a 5-second buffer using Bull MQ. Should be done by EOD.' },
  { role: 'assistant', content: 'Nice. Bull MQ is a solid choice for that — built-in delayed jobs. Did you run into anything unexpected?' },
  { role: 'user', content: 'One thing — we realized we also need to handle duplicate webhooks from Stripe\'s retry logic. Marcus is adding a Redis set to deduplicate before the queue. Should be straightforward.' },
  { role: 'assistant', content: 'Good catch. The dedup + delay queue combo should handle both the ordering and retry issues cleanly.' },
  { role: 'user', content: 'Now the capacity doc. I updated the spreadsheet — here\'s where we are. Current team is 8 engineers: 3 senior backend, 2 mid backend, 1 senior frontend, 2 mid frontend. Jun is the newest, he\'s mid backend, started May 5th.' },
  { role: 'assistant', content: 'Got it. And for the risk engine scenario, you\'d need 2 additional senior backend engineers and a data scientist — so that\'s 11 total headcount plus the data scientist?' },
  { role: 'user', content: 'Right. But I\'m thinking we should also propose a third scenario — take on the risk engine but phase it. Q3 we hire one senior backend and the data scientist, Q4 we hire the second senior backend once the first is ramped. Reduces the Q3 budget ask.' },
  { role: 'assistant', content: 'That\'s smart. Leadership gets a lower upfront number and the phased approach reduces onboarding bottlenecks. Want me to draft that outline now?' },
  { role: 'user', content: 'Yes. Three scenarios: maintain current scope, full risk engine, phased risk engine. For each one I need headcount, estimated quarterly cost, and key risks. Keep it to one page per scenario.' },
  { role: 'assistant', content: 'I\'ll draft that. One question — do you have the loaded cost per headcount or should I use a standard estimate?' },
  { role: 'user', content: 'Use $185k fully loaded for senior backend, $140k for mid, $175k for data scientist. All annual.' },
  { role: 'assistant', content: 'Got it. I\'ll have the outline ready for your review.' },
  { role: 'user', content: 'One more thing — completely separate. I need to book a flight to the Denver office for June 18-20. Direct from SFO preferred. Can you check availability?' },
  { role: 'assistant', content: 'I\'ll look into flights from SFO to Denver for June 18-20. Any airline preference or budget range?' },
  { role: 'user', content: 'United preferred since I have status. Keep it under $400 round trip if possible.' },
  { role: 'assistant', content: 'Noted — United, SFO to Denver, June 18-20, under $400. I\'ll check and get back to you.' },
]

const PROF_S3: Message[] = [
  { role: 'user', content: 'The capacity doc is done. Presented it this morning. Leadership went with the phased approach for the risk engine.' },
  { role: 'assistant', content: 'That\'s the one that made the most sense. So you\'re hiring one senior backend and the data scientist this quarter?' },
  { role: 'user', content: 'Yes. I need to open the reqs today. The senior backend role is the priority — we need someone with distributed systems experience, ideally someone who\'s worked with event-driven architectures since that\'s where the risk engine is headed.' },
  { role: 'assistant', content: 'Makes sense given the webhook work you just went through. Want me to draft the job description?' },
  { role: 'user', content: 'Yes. Senior Backend Engineer, Risk Engine team. Must-haves: 5+ years backend, distributed systems, event-driven architecture, Python or Go. Nice-to-haves: fintech experience, familiarity with fraud detection or risk modeling. Remote-friendly, US time zones.' },
  { role: 'assistant', content: 'I\'ll draft that. What about the data scientist role — opening that simultaneously or waiting?' },
  { role: 'user', content: 'Simultaneously. The data scientist needs ML experience with tabular data — not LLMs, not computer vision. Think gradient boosted trees, feature engineering, model monitoring in production. Ideally someone from a fraud or credit risk background.' },
  { role: 'assistant', content: 'Got it. Two JDs coming up. Anything else from the leadership meeting?' },
  { role: 'user', content: 'One thing — they want a monthly status report on the risk engine starting July 1st. Nothing heavy, just a one-pager with progress, blockers, and spend against budget. Can you remind me about this on June 28th so I can set up the template?' },
  { role: 'assistant', content: 'I\'ll remind you June 28th. Monthly risk engine status report, one-pager format.' },
]

const PROF_S4: Message[] = [
  { role: 'user', content: 'We have a problem with the webhook delay queue.' },
  { role: 'assistant', content: 'What happened?' },
  { role: 'user', content: 'The 5-second buffer isn\'t enough. We\'re seeing Stripe events arrive up to 30 seconds apart in some cases, especially for international transactions. The delay queue processes them at 5 seconds and we still hit the ordering issue.' },
  { role: 'assistant', content: 'Increasing the buffer to 30 seconds would fix it but that\'s a lot of latency. What about the state machine approach Marcus originally proposed? Given that you\'re already tracking events in Redis for dedup, adding state transitions per payment intent might not be as complex as you initially thought.' },
  { role: 'user', content: 'That\'s what I\'m thinking too. We already have the Redis infrastructure and the dedup set gives us a list of which events we\'ve received. Converting that to a proper state machine is maybe 2 days of work.' },
  { role: 'assistant', content: 'And it eliminates the latency concern entirely — you process each event immediately and the state machine handles ordering by only triggering transitions when prerequisites are met.' },
  { role: 'user', content: 'Right. I\'ll have Marcus pivot to the state machine approach. The delay queue code isn\'t wasted — we can repurpose the Bull MQ setup for the risk engine\'s async processing later.' },
  { role: 'assistant', content: 'Good reuse. So the webhook solution is now: Redis dedup set plus a per-payment-intent state machine, processing events immediately as they arrive. Marcus is on it?' },
  { role: 'user', content: 'Yes. Target is to have it done and tested by Wednesday. I also want to add monitoring — an alert if any payment intent has been in a partial state for more than 5 minutes.' },
  { role: 'assistant', content: 'Smart. That catches cases where an expected event never arrives. DataDog or something else for the alerting?' },
  { role: 'user', content: 'DataDog. We already have it set up for the rest of the payment pipeline.' },
]

// ─── Profile 5: Verbose Storyteller (Sarah) ──────────────────────────────────

const VERBOSE_S1: Message[] = [
  { role: 'user', content: 'So I\'ve been thinking a LOT about the backyard situation and I think I\'ve finally landed on what I want to do. You know how I mentioned ages ago that the raised beds were falling apart? Well I went to the garden center on Saturday — the one on Elm Street, not the big box one, I refuse to go there anymore after they sold me that diseased rosebush last spring — and I talked to this incredibly knowledgeable woman named Deb who basically convinced me to go with cedar instead of the pressure-treated pine I was considering. Apparently the chemicals in pressure-treated wood can leach into the soil and that freaks me out because the whole POINT of growing my own vegetables is to avoid chemicals. So cedar it is. She quoted me about $340 for enough lumber to rebuild all three beds, which honestly is more than I wanted to spend but Deb says cedar lasts 15-20 years versus maybe 5 for untreated pine so the math works out.' },
  { role: 'assistant', content: 'Cedar is definitely the right call for vegetable beds — the natural rot resistance means you won\'t need to treat it with anything, and 15-20 years is excellent longevity. $340 for three raised beds worth of cedar lumber is actually reasonable. Are you planning to rebuild them in the same spots, or is this a chance to rethink the layout?' },
  { role: 'user', content: 'Oh my god yes, the layout! That\'s the other thing I wanted to talk about. Right now they\'re all crammed along the back fence which means the tallest bed blocks the afternoon sun from hitting the other two. Classic rookie mistake from three years ago when I had no idea what I was doing. Deb actually drew me a little diagram — I should have taken a photo of it honestly — where you stagger them in an L-shape so the tallest one (that\'s where I do tomatoes and peppers, things that can handle full sun) goes on the west side and then the two shorter beds extend eastward for the leafy greens and herbs that actually prefer a bit of afternoon shade. It\'s so obvious in hindsight. I\'m also thinking about adding a fourth bed eventually, a small one just for strawberries, but that\'s a next-year project. One thing at a time, you know?' },
  { role: 'assistant', content: 'The L-shape layout sounds like a big improvement — orienting the tall crops on the west side so they don\'t shade the others is smart. And separating strawberries into their own bed makes sense since they spread aggressively and can take over a mixed bed pretty quickly. When are you planning to start the rebuild? If you\'re planting tomatoes, you\'d want the beds ready by late April at the latest depending on your zone.' },
  { role: 'user', content: 'Yeah so that\'s the thing — timing is a bit tricky because Marcus and I are going to Portugal in April. Did I tell you about this? His college friend Rui lives in Lisbon and has been begging us to visit for literally years and we finally booked it. Two weeks, April 4th through the 18th. We\'re spending the first week in Lisbon with Rui and his wife Ana (she\'s a chef, which means we are going to eat INCREDIBLY well) and then the second week we\'re renting a car and driving up to Porto and maybe stopping in some smaller towns along the way. I\'ve been reading about this town called Óbidos that\'s apparently like a medieval walled village with cobblestone streets and a castle? It sounds unreal. So anyway the garden rebuild needs to happen either in late March before we leave or in late April when we get back. I\'m leaning toward late April because I don\'t want to rush it and then be stressed about it the whole time we\'re in Portugal.' },
  { role: 'assistant', content: 'Late April sounds like the better call — rushing a rebuild right before a two-week trip is a recipe for stress, and you\'d be worrying about whether the soil settled properly while you\'re supposed to be eating Ana\'s cooking in Lisbon. You\'d still have time to get tomato transplants in by early May if your zone allows it. Óbidos is stunning by the way — the ginjinha (cherry liqueur) served in chocolate cups there is a must-try. Are you doing any food-specific planning for the trip given Ana\'s background?' },
  { role: 'user', content: 'OH the ginjinha in chocolate cups sounds amazing, I\'m writing that down immediately. And yes, Ana has already sent us a massive list of restaurants she wants to take us to — she\'s very particular about it, apparently there are tourist trap restaurants in the Alfama district that she is personally offended by? Which I love honestly. She\'s also offered to do a cooking class type thing with us at their apartment where she teaches us to make pastéis de nata from scratch. Marcus is way more excited about that than he\'s letting on, he\'s been watching YouTube videos about Portuguese custard tarts for weeks now. For Porto she recommended this restaurant called Cantinho do Avillez that\'s run by some famous Portuguese chef. I need to make a reservation, actually — can you remind me to do that? Like in a week or so? I don\'t want to do it now because I need to figure out which specific day we\'ll be in Porto.' },
  { role: 'assistant', content: 'I\'ll remind you about the Cantinho do Avilhez reservation around March 8th. Ana sounds like the perfect local guide — having a chef navigate you away from tourist traps is exactly what you want in Lisbon. The pastéis de nata class sounds incredible, and Marcus secretly watching YouTube tutorials is endearing. Between Ana\'s restaurant list for Lisbon, the cooking class, Óbidos, and Porto, this trip sounds really well-shaped. Want me to help you think through the driving route from Lisbon to Porto when you\'re ready to plan that leg?' },
  { role: 'user', content: 'Yes definitely, but later — right now I should probably focus on the garden stuff before I fall down the Portugal planning rabbit hole again (Marcus says I\'ve been \'aggressively researching\' and he\'s not wrong). So back to the beds — I think the plan is: order the cedar from Deb\'s shop before we leave so it\'s ready when we get back, do the rebuild the last week of April, and then plant in early May. The soil situation is something I need to think about too because the existing soil in the beds has been there for three years and I\'m not sure it\'s still got enough nutrients. Last year my tomatoes were kind of sad and pathetic looking, which Deb said could be a nitrogen depletion issue. She suggested mixing in composted manure and worm castings before replanting. I already have a compost bin going but it\'s definitely not producing enough for three beds plus a potential fourth. Might need to buy some bags of the good stuff. Oh, and I want to try growing zucchini this year even though Marcus claims we\'ll end up with 800 of them and have to start leaving them on neighbors\' doorsteps like everyone says happens. He\'s probably right but I don\'t care.' },
  { role: 'assistant', content: 'That timeline works well — ordering before the trip means Deb has it ready, and you come back with everything staged for the rebuild. For the soil, composted manure plus worm castings is a solid amendment plan for nitrogen depletion. You might also consider a soil test kit before you amend — they\'re cheap and they\'d tell you exactly what\'s depleted so you\'re not guessing. And Marcus is absolutely right about the zucchini, you will have 800 of them, and you will leave them on doorsteps, and it will be wonderful. Start with two plants max.' },
]

const VERBOSE_S2: Message[] = [
  { role: 'user', content: 'Okay so I need to vent for a minute if that\'s alright. I just got off a call with my editor — you know, Janet, the one at Quarterly Review — and she basically told me that the 5,000 word piece I\'ve been working on for the last three weeks needs to be \'substantially reworked\' which is editor-speak for \'this isn\'t good enough.\' And like, I KNOW it\'s not my best work, I\'ve been distracted with the trip planning and the garden and honestly I\'ve been in a bit of a creative rut since January, but hearing it out loud still stings. The piece is supposed to be about the decline of independent bookstores in mid-sized American cities and I think my problem is that I\'m trying to weave in too many threads — the economic angle, the cultural angle, the personal nostalgia angle — and none of them are landing because I\'m spreading myself too thin across all of them. Janet said \'pick a lane\' which is advice I would give to anyone else but apparently cannot apply to my own work.' },
  { role: 'assistant', content: 'That\'s frustrating, especially after three weeks of work. But Janet\'s feedback sounds specific and actionable, which is actually better than vague \'it\'s not working.\' The \'pick a lane\' note is probably right — trying to cover economic, cultural, AND nostalgic angles in 5,000 words means each one gets maybe 1,500 words of real depth, which isn\'t enough for any of them to land. Which angle are you most drawn to when you think about why this piece matters to you?' },
  { role: 'user', content: 'Honestly? The nostalgia angle. But I keep pulling away from it because it feels self-indulgent. Like, who cares that I spent every Saturday morning at The Book Nook in my hometown growing up, you know? But that\'s the thing — I think a LOT of people have a version of that story. There was a bookstore in their town that was more than just a store, it was like a third place (you know that sociology concept? Not home, not work, but the third place where community happens?) and when those places close it\'s not just about retail economics, it\'s about losing something that can\'t be quantified on a spreadsheet. But then I start writing that and I hear this voice in my head that sounds suspiciously like my MFA advisor Dr. Kellerman telling me that personal essay is \'the easiest genre to do badly\' and I freeze up. He was such a pompous man honestly but his criticisms live in my brain rent-free.' },
  { role: 'assistant', content: 'The nostalgia angle IS the piece, and it\'s not self-indulgent — it\'s the thing that makes a bookstore closure essay different from every other retail-decline article. The third place framing is strong because it gives the personal story structural weight. You\'re not just saying \'I miss The Book Nook,\' you\'re saying the loss of these spaces is a loss of social infrastructure. That\'s the lane. As for Dr. Kellerman\'s voice — he\'s right that personal essay is easy to do badly, but you\'re not a student anymore, you\'re a working writer with an editor who commissioned this piece. The whole reason Janet wanted 5,000 words from you is because she trusts your voice. What if you restructured around The Book Nook as the central thread and let the economic and cultural context support that story rather than compete with it?' },
  { role: 'user', content: 'Oh. Oh that\'s actually — yes. The Book Nook as the spine and then the larger context woven around it. Because I actually have great material for that. The owner, Mrs. Patterson, she ran that store for 31 years and I tracked her down last month for an interview (she\'s 74 now, lives in Tucson) and she told me this incredible story about how during the 2008 recession she kept the store open by starting a \'community shelf\' where people could buy a book and leave it for someone who couldn\'t afford one. She ran that program for six years and she says she gave away over 4,000 books. THAT\'S a story. That\'s the thing that a spreadsheet about foot traffic decline doesn\'t capture. Okay I\'m actually feeling better about this now. I think I was so paralyzed by trying to do everything that I forgot I already had the best material sitting in my interview notes. God, sometimes you just need someone to say the obvious thing out loud.' },
  { role: 'assistant', content: 'Mrs. Patterson\'s community shelf program is extraordinary — 4,000 books over six years during a recession. That\'s your lede, or close to it. You\'ve got the personal childhood connection, a compelling central figure with a real story, and the third-place framework to elevate it beyond nostalgia. That\'s a genuinely strong piece. What\'s your deadline for the rework?' },
  { role: 'user', content: 'April 1st, which is tight but doable now that I actually know what I\'m writing. I think I can get a solid draft done this week and then spend the following week revising. I usually do two revision passes — one for structure and argument, one for line-level prose. Janet is actually a really good editor when it comes to structural feedback so I might send her an early draft of just the first section to make sure I\'m on the right track before I write the whole thing. That way if she still doesn\'t like the direction I haven\'t wasted another three weeks. Oh! Speaking of writing — completely different thing — I\'ve been thinking about pitching a travel piece about the Portugal trip to that online magazine, Wanderlust & Words. It\'s a smaller publication but they pay decently and they specifically look for pieces that combine travel with food culture, which is basically what our trip is shaping up to be. I\'d write it after we get back obviously but I want to pitch the idea now so they can hold a slot. Do you think that\'s a good idea or am I overcommitting?' },
  { role: 'assistant', content: 'The timeline works — draft this week, revise next week, early section to Janet for a gut check before you go all in. That\'s smart. On the Portugal pitch to Wanderlust & Words — it\'s a great idea and you should do it. The food-culture-through-Ana\'s-eyes angle practically writes itself, and pitching now while you\'re excited means the enthusiasm comes through in the pitch. You\'re not overcommitting because the writing happens after the trip, and the bookstore piece will be done by April 1st, well before you leave on the 4th. The pitch is a ten-minute email, not a commitment. Send it.' },
]

const VERBOSE_S3: Message[] = [
  { role: 'user', content: 'Quick update on several fronts because I feel like I\'ve been living in a tornado the past two weeks. First: the bookstore piece. I sent Janet the restructured first section and she LOVED it. Her exact words were \'this is the piece I commissioned\' which honestly made me tear up a little at my desk. I\'ve finished the full draft and I\'m in my second revision pass now. Mrs. Patterson even sent me some old photos of The Book Nook from the 80s and 90s that I\'m trying to get permission to include as a sidebar. The one from 1992 with the community reading circle is just — it\'s so good. A dozen people crammed into this tiny store with folding chairs and cups of coffee and you can see the books piled up everywhere. It\'s the visual version of everything the piece is trying to say.' },
  { role: 'assistant', content: 'That\'s fantastic — \'this is the piece I commissioned\' is exactly the feedback you needed. And those photos from Mrs. Patterson could really elevate it, especially the 1992 reading circle. That image of people crammed into a tiny bookstore with coffee and folding chairs captures the third-place argument visually in a way that words alone can\'t. Where are you in the revision? Close to done?' },
  { role: 'user', content: 'Almost — I think I\'ll be done by Thursday, which gives me a day of buffer before the April 1st deadline. My line-level pass is mostly about trimming because I wrote long (surprise surprise) and I need to cut about 600 words to hit the 5,000 target. Killing darlings as they say. The garden update is that I ordered the cedar from Deb and she says it\'ll be ready for pickup on April 22nd which is perfect timing since we get back on the 18th. Marcus is going to help me with the rebuild, he\'s weirdly excited about it, I think he secretly wants to use the circular saw. MEN. Oh and I almost forgot — Wanderlust & Words got back to me on the Portugal pitch and they want it! 2,500 words, due May 15th, they\'re paying $400 which isn\'t life-changing money but it\'s not nothing and more importantly it\'s a clip I can use. I need to remember to take good notes and photos while we\'re there. Maybe I should keep a little travel journal? I always say I\'m going to do that and then I don\'t.' },
  { role: 'assistant', content: 'Thursday with a day of buffer is solid — and cutting 600 words from an already-good draft usually makes it tighter and better. Congrats on the Wanderlust & Words acceptance, $400 for 2,500 words is a solid rate and the clip matters more than the money at this stage. For the travel journal — keep it simple. Use your phone\'s notes app and just jot down sensory details and conversations right after they happen. Don\'t try to write full entries, just capture the raw material. The specific details you forget by May are the ones that make the piece vivid. Also — did you make the Cantinho do Avillez reservation? You\'re leaving in 10 days.' },
  { role: 'user', content: 'OH. No I didn\'t. Thank you for reminding me — I completely spaced on that. I know we\'ll be in Porto around April 12th-ish so let me look at that today. Also I should probably start making a packing list because I always leave that to the last minute and then forget something essential. Last trip I forgot my phone charger and had to buy one at the airport for like $40 which Marcus will never let me live down.' },
  { role: 'assistant', content: 'Book Cantinho do Avillez for April 12th and build in a backup date in case that doesn\'t work. For packing — start a running list now on your phone and add things as you think of them over the next week. Phone charger goes on the list first, obviously. Do you want me to remind you to finalize the packing list on April 2nd, the day before you leave?' },
  { role: 'user', content: 'Yes please, April 2nd packing reminder. You\'re saving me from myself. Okay I need to get back to the revision — those 600 words aren\'t going to cut themselves. Oh one more thing — totally random — but have you heard of this book called \'Braiding Sweetgrass\' by Robin Wall Kimmerer? My friend Jess keeps recommending it, she says it\'s about plants and indigenous knowledge and the way we relate to the natural world. Seems like it might be relevant to the gardening stuff and also just generally up my alley. I might pick it up for the plane.' },
  { role: 'assistant', content: 'Braiding Sweetgrass is wonderful — it\'s part memoir, part science, part philosophy about reciprocity with the natural world. Kimmerer is a botanist and a member of the Citizen Potawatomi Nation, and the way she weaves indigenous knowledge with Western science is beautiful. It\'s perfect plane reading and yes, very relevant to how you think about the garden. Jess has good taste. Go cut those 600 words.' },
]

// ─── Scenario runners ─────────────────────────────────────────────────────────

async function scenarioTerseEngineer(): Promise<number> {
  const dir = await makeTempDir()
  try {
    const mem = new Memory({ llm, storagePath: dir })
    await mem.chunk(TERSE_S1)
    await mem.chunk(TERSE_S2)
    await mem.chunk(TERSE_S3)
    const topics = await mem.getTopics()
    process.stderr.write(`[bench] terse: ${topics.length} topics: ${topics.map(t => t.label).join(', ')}\n`)

    const queries: QuerySpec[] = [
      {
        query: 'what instance type did we pick for rds',
        topicKeywords: ['postgres', 'rds', 'migration', 'database'],
        factKeywords: [['db.r6g.xlarge', 'r6g'], ['4vcpu', '4 vcpu', '32gb'], ['april 5', 'cutover']],
      },
      {
        query: 'what was wrong with the airflow pipeline',
        topicKeywords: ['airflow', 'dbt', 'pipeline', 'stg_orders'],
        factKeywords: [['stg_orders'], ['inventory', 'join', 'full scan'], ['index', 'sku_id', '3min', '45min']],
      },
      {
        query: 'the ssl cert thing',
        topicKeywords: ['ssl', 'cert', 'api.internal'],
        factKeywords: [['api.internal'], ['march 21', '21st'], ['vault', 'internal ca']],
      },
      {
        query: 'the jest problem',
        topicKeywords: ['jest', 'github actions', 'ci', 'tests'],
        factKeywords: [['jest', 'oom'], ['runInBand', 'run-in-band'], ['integration']],
      },
    ]
    return await scoreProfileQueries(mem, topics, queries, 'terse')
  } catch (err) {
    process.stderr.write(`[bench] terse error: ${(err as Error).message}\n`)
    return 0.0
  } finally {
    await cleanDir(dir)
  }
}

async function scenarioScatterbrained(): Promise<number> {
  const dir = await makeTempDir()
  try {
    const mem = new Memory({ llm, storagePath: dir })
    await mem.chunk(SCATTER_S1)
    await mem.chunk(SCATTER_S2)
    await mem.chunk(SCATTER_S3)
    await mem.chunk(SCATTER_S4)
    await mem.chunk(SCATTER_S5)
    const topics = await mem.getTopics()
    process.stderr.write(`[bench] scatter: ${topics.length} topics: ${topics.map(t => t.label).join(', ')}\n`)

    const queries: QuerySpec[] = [
      {
        query: 'what kind of cat do i have',
        topicKeywords: ['cat', 'beans', 'uti', 'pet'],
        factKeywords: [['beans'], ['uti', 'antibiotics'], ['wet food', 'dry food']],
      },
      {
        query: 'when is my sister\'s wedding',
        topicKeywords: ['savannah', 'wedding', 'sister', 'trip'],
        factKeywords: [['june 15', 'june 15th'], ['savannah'], ['ceramics', 'pottery']],
      },
      {
        // Correction recall: original was june 13-17, updated to june 12-17
        query: 'what dates are we flying to savannah',
        topicKeywords: ['savannah', 'flight', 'rochester', 'trip'],
        factKeywords: [['june 12', '12th'], ['rochester', 'roc'], ['taylor']],
      },
      {
        // Correction recall: abandoned running, switched to cycling
        query: 'am i still getting into running',
        topicKeywords: ['cycling', 'bike', 'exercise', 'running'],
        factKeywords: [['cycling', 'bike', 'trek'], ['knee', 'running'], ['15 miles', 'canal']],
      },
    ]
    return await scoreProfileQueries(mem, topics, queries, 'scatter')
  } catch (err) {
    process.stderr.write(`[bench] scatter error: ${(err as Error).message}\n`)
    return 0.0
  } finally {
    await cleanDir(dir)
  }
}

async function scenarioLifeTransition(): Promise<number> {
  const dir = await makeTempDir()
  try {
    const mem = new Memory({ llm, storagePath: dir })
    await mem.chunk(LIFE_S1)
    await mem.chunk(LIFE_S2)
    await mem.chunk(LIFE_S3)
    await mem.chunk(LIFE_S4)
    const topics = await mem.getTopics()
    process.stderr.write(`[bench] life: ${topics.length} topics: ${topics.map(t => t.label).join(', ')}\n`)

    const queries: QuerySpec[] = [
      {
        query: 'how much are we paying for the mortgage and what\'s our savings runway',
        topicKeywords: ['severance', 'financial', 'money', 'savings', 'mortgage'],
        factKeywords: [['2,800', '$2800', 'mortgage'], ['4 months', 'savings'], ['cobra', '1,840', 'insurance']],
      },
      {
        query: 'what did I decide about the Stripe job',
        topicKeywords: ['stripe', 'job', 'career', 'phone screen'],
        factKeywords: [['phone screen'], ['billing platform', 'no spark', 'felt nothing'], ['decision rule', 'contract']],
      },
      {
        query: 'what did Maya tell me about contract rates',
        topicKeywords: ['contract', 'career', 'job', 'woodworking', 'maya', 'transition'],
        factKeywords: [['150', '200', '150-200'], ['network', 'platforms'], ['3 weeks', 'intro']],
      },
      {
        query: 'what kind of car does Jordan drive',
        topicKeywords: [],
        factKeywords: [],
        isNegative: true,
      },
    ]
    return await scoreProfileQueries(mem, topics, queries, 'life')
  } catch (err) {
    process.stderr.write(`[bench] life error: ${(err as Error).message}\n`)
    return 0.0
  } finally {
    await cleanDir(dir)
  }
}

async function scenarioProfessional(): Promise<number> {
  const dir = await makeTempDir()
  try {
    const mem = new Memory({ llm, storagePath: dir })
    await mem.chunk(PROF_S1)
    await mem.chunk(PROF_S2)
    await mem.chunk(PROF_S3)
    await mem.chunk(PROF_S4)
    const topics = await mem.getTopics()
    process.stderr.write(`[bench] prof: ${topics.length} topics: ${topics.map(t => t.label).join(', ')}\n`)

    const queries: QuerySpec[] = [
      {
        // Correction: delay queue → state machine (decision evolved across sessions)
        query: 'what approach did we settle on for the Stripe webhook ordering issue',
        topicKeywords: ['webhook', 'stripe', 'payment', 'gateway'],
        factKeywords: [['state machine'], ['redis', 'dedup'], ['30 seconds', 'international', 'delay queue']],
      },
      {
        query: 'what are the requirements for the senior backend role',
        topicKeywords: ['hiring', 'backend', 'engineer', 'job description'],
        factKeywords: [['5+ years', '5 years'], ['distributed systems', 'event-driven'], ['python', 'go', 'grpc']],
      },
      {
        query: 'what\'s the loaded cost we\'re using for headcount planning',
        topicKeywords: ['capacity', 'headcount', 'cost', 'planning'],
        factKeywords: [['185', '$185k'], ['175', '$175k', 'data scientist'], ['140', '$140k']],
      },
      {
        query: 'when am I flying to Denver',
        topicKeywords: ['denver', 'flight', 'travel'],
        factKeywords: [['june 18', 'june 18-20'], ['sfo', 'united'], ['400', '$400']],
      },
    ]
    return await scoreProfileQueries(mem, topics, queries, 'prof')
  } catch (err) {
    process.stderr.write(`[bench] prof error: ${(err as Error).message}\n`)
    return 0.0
  } finally {
    await cleanDir(dir)
  }
}

async function scenarioVerboseStoryteller(): Promise<number> {
  const dir = await makeTempDir()
  try {
    const mem = new Memory({ llm, storagePath: dir })
    await mem.chunk(VERBOSE_S1)
    await mem.chunk(VERBOSE_S2)
    await mem.chunk(VERBOSE_S3)
    const topics = await mem.getTopics()
    process.stderr.write(`[bench] verbose: ${topics.length} topics: ${topics.map(t => t.label).join(', ')}\n`)

    const retrievalQueries: QuerySpec[] = [
      {
        query: 'what wood did she decide on for the garden beds',
        topicKeywords: ['garden', 'raised bed', 'cedar', 'wood'],
        factKeywords: [['cedar'], ['340', '$340', 'deb'], ['l-shape', 'layout', 'nitrogen']],
      },
      {
        query: 'when is the Portugal trip',
        topicKeywords: ['portugal', 'lisbon', 'porto', 'trip'],
        factKeywords: [['april 4', 'april 4th'], ['rui', 'ana'], ['porto', 'lisbon']],
      },
      {
        query: 'what happened with the bookstore article',
        topicKeywords: ['bookstore', 'writing', 'article', 'janet'],
        factKeywords: [['janet', 'rework', 'substantially'], ['mrs. patterson', 'book nook'], ['this is the piece i commissioned', 'loved']],
      },
      {
        query: 'who is Ana',
        topicKeywords: ['portugal', 'lisbon', 'ana', 'rui'],
        factKeywords: [['chef', 'cook'], ['pastéis de nata', 'pastel', 'cooking class'], ['rui', 'lisbon']],
      },
    ]

    const retrievalScore = await scoreProfileQueries(mem, topics, retrievalQueries, 'verbose')

    // Archival fidelity sub-test: find largest topic, archive it, verify key facts survive
    let archivalScore = 0
    if (topics.length > 0) {
      const largest = topics.reduce((a, b) => a.estimatedTokens > b.estimatedTokens ? a : b)
      process.stderr.write(`[bench] verbose compact: "${largest.label}" (${largest.estimatedTokens} tokens)\n`)
      await mem.compact(largest.topicId)

      const gardenFacts = ['cedar', 'l-shape', 'april 22', 'nitrogen', 'zucchini']
      let survived = 0
      for (const fact of gardenFacts) {
        const results = await mem.retrieve(`garden raised bed ${fact}`)
        if (chunksContainText(results, fact)) survived++
      }
      archivalScore = survived / gardenFacts.length
      process.stderr.write(`[bench] verbose compact: ${survived}/${gardenFacts.length} facts survived\n`)
    }

    // Weight: 75% retrieval, 25% archival
    return retrievalScore * 0.75 + archivalScore * 0.25
  } catch (err) {
    process.stderr.write(`[bench] verbose error: ${(err as Error).message}\n`)
    return 0.0
  } finally {
    await cleanDir(dir)
  }
}

// ─── Main benchmark loop ───────────────────────────────────────────────────────

async function runOnce(runNum: number): Promise<Record<string, number>> {
  process.stderr.write(`\n[bench] === Run ${runNum}/5 ===\n`)

  const [s1, s2, s3, s4, s5] = await Promise.all([
    scenarioTerseEngineer(),
    scenarioScatterbrained(),
    scenarioLifeTransition(),
    scenarioProfessional(),
    scenarioVerboseStoryteller(),
  ])

  process.stderr.write(
    `[bench] run ${runNum}: terse=${s1.toFixed(2)} scatter=${s2.toFixed(2)} life=${s3.toFixed(2)} prof=${s4.toFixed(2)} verbose=${s5.toFixed(2)}\n`
  )

  return {
    terse_engineer: s1,
    scatterbrained: s2,
    life_transition: s3,
    professional: s4,
    verbose_storyteller: s5,
  }
}

async function main() {
  const startTime = Date.now()
  const RUNS = 5
  const accumulated: Record<string, number[]> = {
    terse_engineer: [],
    scatterbrained: [],
    life_transition: [],
    professional: [],
    verbose_storyteller: [],
  }

  for (let i = 1; i <= RUNS; i++) {
    const runTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Run timed out after 10 minutes')), 10 * 60 * 1000)
    )

    let scores: Record<string, number>
    try {
      scores = await Promise.race([runOnce(i), runTimeout])
    } catch (err) {
      process.stderr.write(`[bench] run ${i} failed: ${(err as Error).message}\n`)
      scores = Object.fromEntries(Object.keys(accumulated).map(k => [k, 0]))
    }

    for (const [k, v] of Object.entries(scores)) {
      accumulated[k]?.push(v)
    }
  }

  const avg = (arr: number[]) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length
  const min = (arr: number[]) => arr.length === 0 ? 0 : Math.min(...arr)

  const results: Record<string, number> = {}
  const minimums: Record<string, number> = {}
  for (const [k, v] of Object.entries(accumulated)) {
    results[k] = avg(v)
    minimums[k] = min(v)
  }

  const composite = avg(Object.values(results))
  const minComposite = avg(Object.values(minimums))
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  // Save timestamped results
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const resultsDir = path.join(process.cwd(), 'results')
  await fs.mkdir(resultsDir, { recursive: true })

  let output = '\nBENCHMARK RESULTS\n=================\n'
  for (const [k, v] of Object.entries(results)) {
    output += `${k}: ${v.toFixed(2)}  (min: ${(minimums[k] ?? 0).toFixed(2)})\n`
  }
  output += `-----------------\nCOMPOSITE: ${composite.toFixed(2)}  (min-composite: ${minComposite.toFixed(2)})\n`

  console.log(output)
  await fs.writeFile(path.join(resultsDir, `${ts}.txt`), output)
  process.stderr.write(`\n[bench] total elapsed: ${elapsed}s\n`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
