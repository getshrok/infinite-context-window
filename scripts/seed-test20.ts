/**
 * Seeds the test20 Saturday env with Jordan's life-transition conversation history.
 * Run: npm run seed-test20
 */

import Anthropic from '@anthropic-ai/sdk'
import { Memory } from '../src/index.js'
import type { Message } from '../src/index.js'

const TOPICS_PATH = '/home/thenasty/.saturday-test20/topics'

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

// ─── Jordan's sessions ────────────────────────────────────────────────────────

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

// ─── Main ─────────────────────────────────────────────────────────────────────

const sessions = [
  { label: 'Session 1 (layoff, severance shock)', messages: LIFE_S1 },
  { label: 'Session 2 (plan taking shape)', messages: LIFE_S2 },
  { label: 'Session 3 (Maya call, woodworking class)', messages: LIFE_S3 },
  { label: 'Session 4 (lawyer, Stripe screen, garage workshop)', messages: LIFE_S4 },
]

const mem = new Memory({ storagePath: TOPICS_PATH, llm })

for (const { label, messages } of sessions) {
  console.log(`Chunking: ${label} (${messages.length} messages)...`)
  await mem.chunk(messages)
  console.log('  done')
}

const topics = await mem.getTopics()
console.log(`\nDone. ${topics.length} topics stored:`)
for (const t of topics) {
  console.log(`  [${t.topicId.slice(0, 8)}] ${t.label} — ${t.chunkCount} chunk(s)`)
}
