# Situation library — the dispatcher's notebook

Status: Draft for human approval. Added phrasings are examples, not real transcripts.

**This file is the agent's source of truth.** `npm run library:compile` turns the blocks below into the table the classifier runs on, and a test fails if the two ever disagree. Editing this file is how the agent changes; there is no second copy to keep in sync.

**Status** is the safety catch. `approved` blocks are live. `proposed` blocks are written down, reviewable, and deliberately invisible to the classifier — writing a block here never switches it on. Eight are approved today: `breakdown`, `accident`, `inspection`, `customer`, `traffic`, `rest`, `fuel`, `all_good`.

One block per situation. Write how drivers actually talk: broken English, half sentences, whatever comes over the phone at two in the morning. The more phrasings, the better the agent hears. Nothing here is a rule the agent invents on its own; a human approves this file, then the agent uses it.

**Level** decides who hears about it and when:
- `0` — log only; the morning briefing lists it.
- `1` — morning briefing calls it out; ETA updated.
- `2` — dispatcher gets an email now.
- `3` — dispatcher gets an email now AND the phone call.

Levels are about **who has to wake up**, not about how bad the driver's night is. A driver stuck four hours at a closed receiver is having a worse night than one at a weigh station, and both are level 2: a dispatcher can work them from a desk. Level 3 is for "someone has to be sent, or someone could be hurt."

**Order matters.** Blocks are written most serious first, `all_good` last. When a reply matches two blocks equally well, the one written higher up wins — that is why `all_good` sits at the bottom: *"yeah I'm fine, police pulled me over"* is an inspection, not an all-good.

**Two lists per block, and they do different jobs.** *Driver says* is how drivers actually talk — long, messy, the way it comes off the phone. It is what the agent is **tested** against: every line in it must not land in the wrong block. *Agent listens for* is the short list the classifier actually keys on. Keep it distinctive: a word that ordinary English uses for something else ("fine", "hit", "break", "closed", "scale", "fire") drags in sentences that are not this situation. Add freely to *Driver says*; add carefully to *Agent listens for*.

**Then asks** are the follow-up questions, in order. The agent asks the next one only if the driver's answer didn't already cover it. Keep each one answerable in one breath. Mark with `[number]` when the answer is a number the agent should record (minutes, kilometers), `[yes/no]` when it's a yes or no, and `[text]` when the answer is words to write down. Every question must carry one of the three — an unmarked question is one nobody decided what to do with, and the build says so.

**Careful** is the margin note: the phrasings a block steals from its neighbours, and which one should win. Write one whenever you add a phrase a nearby block could also claim.

---

## breakdown — level 3
Status: approved
Driver says:
- breakdown
- broke down
- my tire is broken
- I had a breakdown, my tire
- flat tire
- engine light
- won't start
- overheating
- need a tow
- truck broke
- truck no start
- motor no working
- engine stopped, cannot start again
- I turn key, nothing
- truck losing power
- cannot drive, truck broken
- tire gone flat
- tyre puncture
- tire blow out
- my wheel, the tire, is busted
- air going out from tire
- I got flat on trailer
- engine too hot
- temperature going up, I stopped
- smoke from engine
- belt broken
- hose burst
- coolant leaking
- oil leaking from motor
- gearbox problem, no gear
- brakes not working
- losing air pressure
- truck stuck here, need mechanic
- send tow truck please
- on shoulder, mechanical problem
- no, breakdown, my, my tire broken
- clutch is gone
- cannot put it in gear
- steering very heavy, something wrong
- red light on the dash
- adblue fault
- def light on, truck derating
- truck goes only twenty kilometers per hour
- truck in limp mode
- turbo gone
- battery dead, no power
- starter not turning
- alternator light on
- lights not working, cannot drive at night
- wiper broken and it is raining
- air leak, brakes locking
- parking brake stuck
- fuel filter blocked, engine cutting
- something broken underneath
- I hear a bad noise from the wheel
- vibration very strong, I stopped

- truck not moving
- not moving for one hour, something wrong
Agent listens for:
- breakdown
- broke down
- broken down
- flat
- tire
- engine
- check engine
- won't start
- wont start
- tow
- mechanic
- overheating
- overheat

Agent replies: Understood. Are you safe? Dispatch is being notified now.

Then asks:
1. Are you safe and off the road? [yes/no]
2. Can the truck move at all? [yes/no]
3. Do you need a tow or a mechanic? [yes/no]
4. How long until you think you can roll? [number, minutes]

Dispatcher note: Driver reports a breakdown.

Careful: "smoke from engine" is a breakdown; "smoke from the trailer" or "smoke from the load" is `spill`. A driver who says the brakes are on fire is `spill`, not this.

---

## accident — level 3
Status: approved
Driver says:
- accident
- crash
- somebody hit me
- I hit a car
- rollover
- I had accident
- we crashed
- car hit my truck
- someone hit trailer
- somebody run into me
- hit me from behind
- I rear ended a car
- I bumped another truck
- clipped a car
- scraped another vehicle
- truck on its side
- trailer tipped over
- I rolled the truck
- I hit the barrier
- hit guardrail
- went into ditch, crashed
- truck jackknifed, I crashed
- collision here, my truck involved
- small accident, nobody hurt
- somebody hit me, they left
- hit parked car backing up
- I hit something, truck damaged
- I touched a car in the parking
- my mirror hit his mirror
- I hit the dock, there is damage
- I hit the gate at the customer
- trailer hit the low roof
- I hit the bridge
- a deer ran into me
- an animal hit my truck
- a car came in front, I braked, we touched
- police coming for the accident report
- I am in the ambulance
- the fire brigade is here

Agent listens for:
- accident
- crash
- crashed
- collision
- wreck
- ambulance
- hit a car
- got hit
- hit by
- rollover
- rolled the truck

Agent replies: Are you OK? Dispatch is being notified now.

Then asks:
1. Is anyone hurt? [yes/no]
2. Are the police there or on the way? [yes/no]
3. Can the truck move? [yes/no]

Dispatcher note: Driver reports an accident.

Careful: "accident ahead, traffic stopped" is somebody else's accident — that is `traffic`. Only this block when the driver's own truck is in it. Never build it out of the bare word "hit": drivers hit traffic, hit the road, hit the brakes. "The other driver" alone is not a collision — it is only this block next to a crash word, and those already match. "The other driver is calling the police" on its own reads as an inspection and is not claimed here — a crash message carries a crash word.

---

## medical — level 3
Status: proposed
Driver says:
- I feel very bad
- I am sick
- feeling sick, cannot drive
- I have to vomit
- I am dizzy
- my head is spinning
- chest pain
- my chest hurts
- pain in my arm and chest
- I cannot breathe good
- my heart is beating strange
- my sugar is low
- I am diabetic, I feel bad
- blood pressure very high
- I have fever
- very strong headache
- my back is blocked, I cannot move
- I cut my hand
- I fell from the trailer
- I hurt my leg
- I burned my hand
- something in my eye
- I took medicine, I am sleepy
- I cannot keep my eyes open
- I am too tired to drive
- falling asleep at the wheel
- I need a doctor
- they called an ambulance for me
- I am at the hospital
- I need a pharmacy for medicine

Agent listens for:
- i am sick
- feeling sick
- have to vomit
- i am dizzy
- head is spinning
- chest pain
- my chest hurts
- cannot breathe
- heart is beating
- my sugar is low
- blood pressure
- i have fever
- strong headache
- cut my hand
- hurt my leg
- burned my hand
- i need a doctor
- at the hospital
- falling asleep
- keep my eyes open
- too tired to drive
- i need a pharmacy

Agent replies: Understood. Are you safe where you are? Dispatch is being notified now.

Then asks:
1. Are you parked somewhere safe? [yes/no]
2. Do you need an ambulance? [yes/no]
3. Can you continue driving today? [yes/no]

Dispatcher note: Driver reports a medical problem.

Careful: "I am tired" with the truck already parked is `rest`. "I cannot keep my eyes open" while rolling is this block — the answer is stop now, not a line in the morning briefing. A driver who is out of legal hours but feels fine is `hours`.

---

## spill — level 3
Status: proposed
Driver says:
- something is leaking
- leak from the tank
- product is coming out
- the load is leaking on the road
- liquid under the trailer
- I smell chemical
- strong smell from the load
- smoke from the trailer
- smoke from the load
- brakes on fire
- fire on my truck
- something is burning
- burning smell, I stopped
- the tire caught fire
- a drum is broken, product outside
- a pallet fell, boxes broken on the road
- the load fell down
- my load moved, the doors will not open
- straps broke, load moved
- trailer doors open on the road
- boxes fell out
- the barrel is damaged
- the valve is dripping
- seal broken, product coming out
- adr load is leaking
- I have dangerous goods and there is a leak
- fire brigade coming for the load
- police closed the road because of my load
- powder spilled everywhere

Agent listens for:
- something is leaking
- leak from the tank
- product is coming out
- product coming out
- leaking on the road
- liquid under the trailer
- smell chemical
- smell from the load
- smoke from the trailer
- smoke from the load
- brakes on fire
- on fire
- caught fire
- something is burning
- burning smell
- drum is broken
- barrel is damaged
- valve is dripping
- adr load
- dangerous goods
- powder spilled
- boxes fell out
- load fell down
- straps broke
- doors open on the road
- tire caught fire

Agent replies: Understood. Get clear of the load and stay upwind. Are you safe? Dispatch is being notified now.

Then asks:
1. Are you away from the load and safe? [yes/no]
2. Is anything still running onto the road? [yes/no]
3. Are the fire brigade or police there or on the way? [yes/no]
4. What number is on the orange plate? [number]

Dispatcher note: Driver reports a leak, spill, or fire involving the load.

Careful: this outranks `breakdown` even when the truck is broken too — a tow can wait for a phone call, a leak cannot. "Coolant leaking" and "oil leaking from motor" stay in `breakdown`: that is the truck's own fluid, not the cargo.

---

## theft — level 3
Status: proposed
Driver says:
- somebody broke into my trailer
- trailer broken open
- the seal is cut
- the lock is cut
- they cut the curtain
- curtain slashed
- the load is missing
- pallets missing from the trailer
- somebody stole from the trailer
- diesel stolen
- they took the fuel from my tank
- tank cap broken, fuel gone
- my bag is stolen
- documents stolen
- papers and phone stolen
- somebody is around the truck
- people trying to open the doors
- I hear somebody on the trailer
- a man is knocking on my door
- somebody wants me to open
- they are following me
- I do not feel safe here
- somebody threatened me
- they took my keys
- the truck is gone
- I came back and there is no truck
- battery and cables stolen
- the catalyst was cut off my truck
- somebody sprayed something in the parking

Agent listens for:
- broke into
- trailer broken open
- seal is cut
- lock is cut
- cut the curtain
- curtain slashed
- load is missing
- pallets missing from
- stolen
- somebody stole
- they took the fuel
- somebody is around the truck
- trying to open the doors
- somebody threatened me
- took my keys
- the truck is gone
- do not feel safe
- they are following me
- tank cap

Agent replies: Understood. Stay in the cab with the doors locked if you can. Dispatch is being notified now.

Then asks:
1. Are you safe right now? [yes/no]
2. Are the police there or on the way? [yes/no]
3. Is anything missing from the trailer? [yes/no]
4. Is the seal number still the one on your papers? [yes/no]

Dispatcher note: Driver reports theft, a cut seal, or people around the truck.

Careful: a broken seal found at the receiver, nothing missing and nobody around, is `documents` — that is a paperwork fight. This block is for a driver who has been robbed or is frightened right now.

---

## stuck — level 3
Status: proposed
Driver says:
- I am stuck
- the truck cannot move
- stuck in the snow
- wheels spinning, no grip
- stuck in the mud
- I went off the asphalt and cannot get out
- trailer in the ditch, no damage
- I sank in the gravel
- I cannot reverse out
- the street is too narrow, I cannot turn
- I am blocked between cars
- I cannot go forward or back
- the bridge is too low, I cannot pass and cannot turn
- I am under the bridge and cannot move
- the barrier is too low for the truck
- I am blocked inside the yard
- the gate is too small for my trailer
- they parked me in, I cannot leave
- I need snow chains, I have none
- the road is ice, I cannot climb the hill
- I slid off the road
- I need a recovery truck
- I need a tractor to pull me out
- I am blocking the road

Agent listens for:
- stuck in the snow
- stuck in the mud
- wheels spinning
- cannot get out
- cannot reverse out
- too narrow
- cannot turn
- cannot go forward
- i am blocked
- parked me in
- slid off the road
- recovery truck
- pull me out
- blocking the road
- snow chains
- cannot climb the hill
- too low, i cannot pass

Agent replies: Understood. Are you safe? Dispatch is being notified now.

Then asks:
1. Are you safe and out of the traffic lane? [yes/no]
2. Is the truck damaged? [yes/no]
3. Do you need a recovery vehicle? [yes/no]
4. How long until you think you can move? [number, minutes]

Dispatcher note: Driver is immobilized and needs recovery.

Careful: "stuck in traffic" is `traffic` — the truck can move, the road cannot. This block is the truck that physically cannot move and is not broken. If it was damaged getting there, it is `accident`.

---

## refusal — level 3
Status: proposed
Driver says:
- I am not driving this
- I refuse this load
- I am not going there
- I go home now
- I am finished, I go home
- I quit
- I leave the truck here
- I am not unloading by hand
- it is not my job to unload
- I will not do the second delivery
- this is not what dispatch told me
- nobody pays me for this waiting
- I am not waiting any more, I leave
- I do not have the license for this
- I am not trained for this load
- I will not drive without the papers
- the truck is not safe, I refuse
- I will not drive over my hours
- I do not go to that country
- I am not going in that yard, it is not safe
- I want to talk to the boss now
- call the boss, I am not moving

Agent listens for:
- i refuse
- i am not driving
- i am not going
- i go home
- i am finished
- i quit
- not my job
- leave the truck here
- i am not waiting
- i will not drive
- call the boss
- talk to the boss
- nobody pays me

Agent replies: Understood — I'm not going to argue with you. Dispatch is being notified now and will call you.

Then asks:
1. Are you somewhere safe and legal to stand? [yes/no]
2. Is the load still sealed and on the trailer? [yes/no]
3. Will you stay with the truck until dispatch calls? [yes/no]

Dispatcher note: Driver refuses to continue.

Careful: "I will not drive over my hours" belongs here, not in `hours` — a driver who is arguing needs a human, a driver who is simply out of time needs a plan. Both get written down; only this one rings the phone.

---
## inspection — level 2
Status: approved
Driver says:
- police
- DOT
- weigh station
- pulled over
- inspection
- police stop me
- officer pulled me over
- cop checking my papers
- DOT stopped me
- D O T inspection
- at scale, they checking truck
- they pulled me into weigh station
- got called into inspection bay
- roadside check
- vehicle inspection now
- checking my logbook
- officer looking at my hours
- checking truck and trailer
- brake inspection
- they checking axle weight
- waiting for officer to finish
- police have my documents
- cannot leave yet, inspection
- stopped for paperwork check
- they stopped me at the tunnel control
- traffic police control
- inspectors checking the adr papers
- they are checking the tachograph
- they downloaded my card
- they want the transport order
- they are looking in the trailer
- dog unit checking the truck
- immigration checking the trailer
- they opened the seal for the check
- I got a control at the exit of the terminal

Agent listens for:
- police
- cop
- cops
- dot
- inspection
- weigh station
- scale
- scales
- pulled over

Agent replies: Understood. Message me when you're rolling.

Then asks:
1. How long do they say it will take? [number, minutes]

Dispatcher note: Driver is stopped for police or a DOT inspection.

Careful: an inspection that ends in a penalty is `fine`; an inspection that ends in "you are too heavy, fix it" is `overweight`. Keep this block for the waiting itself.

---

## customer — level 2
Status: approved
Driver says:
- nobody here
- they are closed
- wrong address
- waiting to unload
- no dock
- customer closed
- gate locked
- warehouse shut
- no one answering at receiver
- security says come back later
- they won't let me in
- address takes me wrong place
- this is not the warehouse
- receiver says wrong location
- they don't have my appointment
- they say no booking for me
- they not ready for load
- freight not ready
- waiting to load
- still waiting for a door
- all docks full
- no free door
- no forklift driver
- nobody to unload me
- been here two hours, still waiting
- customer says wait outside
- they refusing the load
- receiver won't take delivery
- they say appointment tomorrow
- no paperwork ready at customer
- they cannot find my load number
- the warehouse man went home
- they say the system is down
- they tell me to wait in the queue outside
- I am number twelve in the queue
- they close for lunch, two hours
- they want a booking reference I do not have
- they will not unload without an appointment
- they say the goods are not for them
- they only accept until four o'clock
- they say come tomorrow morning
- I am waiting since six hours
- nobody answers the phone at the customer
- the yard is full, they keep us outside

Agent listens for:
- not ready
- nobody here
- no one here
- wrong address
- can't find
- cant find
- no dock
- waiting to unload
- waiting to load
- waiting on them
- is closed
- they are closed
- they're closed
- closed until
- close for lunch

Agent replies: Understood, I'm telling dispatch.

Then asks:
1. Is someone there you can talk to? [yes/no]
2. Did they give you a time? [number, minutes]

Dispatcher note: Customer not ready, or wrong address.

Careful: the customer being closed is this block; a road being closed is `traffic`. "I cannot reach the address because the truck does not fit" is `access` — the receiver is right, the route is wrong.

---

## border — level 2
Status: proposed
Driver says:
- I am at the border
- waiting at the border
- big queue at the border
- customs
- at customs now
- customs is holding me
- customs want to check the trailer
- they sent me to the terminal for customs
- the agent is not here yet
- the broker did not send the papers
- waiting for T1
- T1 not ready
- they say the document is wrong
- the customs system is down
- the code does not match the goods
- they opened the trailer at customs
- physical control at customs
- waiting for the stamp
- they took my papers inside
- three hours in the queue at the border
- trucks not moving at the border
- border is closed for trucks now
- they only take twenty trucks per hour
- they say I need another insurance
- green card problem at the border
- they want the veterinary paper
- the phyto certificate is missing
- customs closed for the night
- I am waiting for the escort

Agent listens for:
- border
- customs
- t1
- waiting for the stamp
- the agent is not here
- green card
- phyto
- veterinary paper
- t1 not ready
- border is closed

Agent replies: Understood, I'm telling dispatch. Message me when you're through.

Then asks:
1. Are the papers with customs or still with you? [yes/no]
2. How long do they say it will take? [number, minutes]

Dispatcher note: Driver is held at a border or customs.

Careful: "queue at the border" is this block, not `traffic` — dispatch fixes it with a phone call to an agent, not with a new ETA. A ferry or shuttle queue is `ferry`.

---

## hours — level 2
Status: proposed
Driver says:
- I have no more hours
- out of hours
- my driving time is finished
- no more driving time today
- I must stop now for the law
- tachograph says stop
- the tacho is beeping
- I am on nine hours already
- I need my daily rest
- I need forty five minutes now
- my card is full
- I forgot my driver card
- the card does not read
- I drove too long, I need a break
- I can drive only one more hour
- I will not make it in my hours
- I need my weekly rest here
- I cannot start before six in the morning
- I have to wait eleven hours
- my rest is not finished
- I still have three hours of rest
- I must take a reduced rest
- the law says I stop
- I am out of time, I stop here

Agent listens for:
- no more hours
- out of hours
- driving time is finished
- no more driving time
- tachograph
- tacho
- my card is full
- driver card
- daily rest
- weekly rest
- my rest
- forty five
- over my hours
- out of time
- i must stop now
- eleven hours
- of rest
- reduced rest

Agent replies: Understood, I'm telling dispatch. Take your rest — I'll update the ETA from the time you can drive again.

Then asks:
1. When can you legally drive again? [number, minutes]
2. Are you parked somewhere you can stay? [yes/no]

Dispatcher note: Driver is out of driving hours and has to rest.

Careful: this is the legal clock, `rest` is the driver's choice. If both are true — "I am taking my forty five now" — this block wins, because dispatch has to move the delivery time. `refusal` is when the argument is about who decides, not about the clock.

---

## documents — level 2
Status: proposed
Driver says:
- I have no papers for this load
- the CMR is missing
- no delivery note
- the papers are wrong
- the papers say another company
- the paper says another address
- wrong load number on the papers
- they gave me the wrong documents
- the receiver wants a document I do not have
- they want the delivery note stamped
- nobody stamped my CMR
- they will not sign the paper
- the seal number does not match the paper
- the seal is different from my document
- the pallet count is not the same
- they counted less pallets
- two pallets missing on the paper
- they say the goods are damaged
- boxes are wet
- the pallet is broken, they refuse to sign
- they wrote a remark on the CMR
- they want to make a claim
- I have no adr paper for this
- no safety data sheet in the truck
- the weight on the paper is not real
- I do not have the customs papers with me
- they want the pallet exchange note
- no pallets to exchange

Agent listens for:
- no papers
- papers are wrong
- the papers say
- cmr
- delivery note
- wrong documents
- will not sign
- nobody stamped
- seal number
- pallet count
- counted less
- goods are damaged
- boxes are wet
- make a claim
- safety data sheet
- pallet exchange
- cannot find my load number
- on the paper

Agent replies: Understood, I'm telling dispatch. Don't sign anything you don't agree with.

Then asks:
1. Are they refusing the load, or only the paperwork? [yes/no]
2. Did you take photos of the papers and the load? [yes/no]
3. Is there someone there who can talk to dispatch? [yes/no]

Dispatcher note: Paperwork problem, damage, or a disputed count at the customer.

Careful: a driver who cannot get in the gate is `customer`; a driver who is in the gate and the paper is wrong is this block. A cut seal in a parking lot at night is `theft`.

---

## overweight — level 2
Status: proposed
Driver says:
- they say I am too heavy
- overweight
- I am over the axle
- the drive axle is too heavy
- too much on the front axle
- the scale says eighteen tons on the axle
- I am one ton over
- they will not let me go, too heavy
- I have to move the load back
- they say I must reload
- I must take some pallets off
- they want me to unload some of it
- the customer loaded me too heavy
- the loading was not correct, weight is wrong
- the paper says twenty four tons but I weigh more
- I need to go to a public scale
- they weighed me at the exit
- I cannot pass the weight control like this
- they say the load is not distributed
- the trailer is loaded to the back

Agent listens for:
- too heavy
- overweight
- over the axle
- axle is too heavy
- one ton over
- i must reload
- pallets off
- not distributed
- loaded to the back
- weight control

Agent replies: Understood, I'm telling dispatch. Don't move the load without them.

Then asks:
1. How much over are you, and on which axle? [number]
2. Are they holding the truck until it is fixed? [yes/no]
3. Can the load be moved on the trailer where you are? [yes/no]

Dispatcher note: Driver is overweight and cannot leave until it is fixed.

Careful: the waiting at the scale is `inspection`; the moment they say the numbers are wrong it becomes this block. A penalty on top of it is `fine`.

---

## access — level 2
Status: proposed
Driver says:
- the truck does not fit
- I cannot reach this address with a truck
- no truck road here
- trucks not allowed on this street
- there is a sign, no trucks
- weight limit on the bridge, I cannot pass
- height limit, three point eight
- the tunnel does not allow adr
- adr is forbidden in this tunnel
- the navigation sent me on a small road
- GPS sent me the wrong way
- I am in a village, I cannot turn around
- the road is only for cars
- the yard is too small for a semi trailer
- they have no place for a big truck
- driving ban today
- Sunday driving ban
- trucks cannot drive today, holiday
- the ban starts at ten, I cannot continue
- the city does not allow trucks at night
- I need a permit for this zone
- environment zone, my truck is not allowed
- the pass is closed for trucks
- chains obligatory, they will not let me pass
- police turned me back from the road

Agent listens for:
- does not fit
- no truck road
- trucks not allowed
- no trucks
- height limit
- weight limit
- driving ban
- cannot pass
- navigation sent me
- gps sent me
- too small for my trailer
- environment zone
- permit for this zone
- cannot reach this address
- turned me back
- forbidden in this tunnel
- only for cars
- the pass is closed
- closed for trucks

Agent replies: Understood, I'm telling dispatch. Don't force it — stay where you can still turn around.

Then asks:
1. Can you still turn around from where you are? [yes/no]
2. What exactly stops you — a sign, a height, or the police? [text]
3. How far are you from the delivery? [number]

Dispatcher note: Driver cannot reach the address, or the road is closed to trucks.

Careful: a road closed to everybody is `traffic`; a road closed to trucks is this block, because the fix is a new route, not a new ETA. If the truck is already wedged, it is `stuck`.

---

## equipment — level 2
Status: proposed
Driver says:
- the reefer is not working
- fridge stopped
- the temperature is going up
- it says minus two, it must be minus eighteen
- the cooling unit gives an alarm
- reefer alarm
- the reefer has no fuel
- the tank heating is not working
- the steam connection is not good
- the compressor is not working
- the tail lift is broken
- the lift will not go down
- the doors will not close
- I cannot lock the trailer
- the ramp is broken
- I have no straps
- I do not have enough straps for this
- the curtain will not close
- the roof is torn
- water is coming in the trailer
- the trailer lights are not working
- no light on the trailer plate
- the trailer brakes are dragging
- the trailer tire is low
- they gave me the wrong trailer
- this trailer is not clean for food
- the tank was not washed
- I have no cleaning certificate
- the wrong trailer number is on the paper
- the coupling will not release
- the king pin is stuck
- I have no adr equipment in the truck
- the fire extinguisher is expired

Agent listens for:
- reefer
- fridge stopped
- cooling unit
- temperature is going up
- tank heating
- steam connection
- tail lift
- ramp is broken
- curtain will not close
- roof is torn
- wrong trailer
- not clean for food
- tank was not washed
- cleaning certificate
- king pin
- coupling
- fire extinguisher
- trailer lights
- doors will not close

Agent replies: Understood, I'm telling dispatch.

Then asks:
1. Is the load itself still OK? [yes/no]
2. Can you keep driving with it like this? [yes/no]
3. What does the display say right now? [number]

Dispatcher note: Trailer or equipment problem — the truck itself is fine.

Careful: the truck's own faults are `breakdown`. A temperature alarm is this block until the product is actually spoiling or leaking — then it is `spill`.

---

## payment — level 2
Status: proposed
Driver says:
- the fuel card does not work
- my card was refused
- the card says declined
- no money on the card
- they will not take my card here
- the card has no diesel limit
- I cannot pay the toll
- no money for the toll
- the toll box does not work
- the toll gate will not open
- my toll device is not registered
- I have no cash for the parking
- they want cash for the ferry
- they want cash for the wash
- I have to pay the customs fee myself
- the agent wants money before he gives papers
- they want money for the unloading
- lumper fee, they want payment
- I have no money for a hotel
- I have nothing to eat, no money on card
- they blocked my card at the station
- pin does not work on the card

Agent listens for:
- fuel card
- card does not work
- card was refused
- declined
- no money
- cannot pay
- no cash
- toll
- lumper
- blocked my card
- pin does not work
- diesel limit
- want cash
- fee

Agent replies: Understood, I'm telling dispatch.

Then asks:
1. How much do you need, and for what? [number]
2. Can you wait where you are until dispatch answers? [yes/no]

Dispatcher note: Driver cannot pay for fuel, toll, or a fee.

Careful: "no fuel on the card" is this block; "I am filling up" is `fuel`; "I ran out of diesel on the road" is `breakdown` — the truck is not moving either way.

---

## not_the_driver — level 2
Status: proposed
Driver says:
- this is not the driver
- wrong number
- who is this
- he is sleeping, I am his wife
- I am his brother, he left the phone
- he gave me the phone
- the driver is not here
- he is inside the warehouse
- he left the phone in the cabin
- I found this phone
- I am the mechanic, not the driver
- I do not know about a truck
- I do not work there any more
- he is not driving today
- another driver has the truck now
- I am at home, I am not on that load
- stop calling me
- do not send me messages
- I do not want these messages

Agent listens for:
- not the driver
- wrong number
- he is sleeping
- his wife
- his brother
- the driver is not here
- left the phone
- found this phone
- stop calling me
- i do not work there
- another driver has the truck
- i am the mechanic

Agent replies: Sorry to bother you — I'll tell dispatch this number isn't the driver's.

Then asks:
1. Is the driver reachable on another number? [yes/no]

Dispatcher note: The number answering is not the driver's.

Careful: this stops the ladder for that trip. The agent must never keep questioning a person who says they are not the driver — dispatch fixes the number, not the agent.

---

## fine — level 2
Status: proposed
Driver says:
- I got a fine
- they gave me a penalty
- police wrote me a ticket
- fine for the tachograph
- they fined me for the weight
- penalty for speed
- fine for the missing paper
- they want me to pay now
- they will not release the truck until I pay
- they took my license
- they took the truck documents
- they say I must pay two hundred euro
- they immobilized the truck
- I have to go to court
- they say I cannot drive until tomorrow
- they blocked the truck with a clamp

Agent listens for:
- i got a fine
- a fine for
- they fined me
- gave me a penalty
- wrote me a ticket
- took my license
- immobilized the truck
- with a clamp
- will not release the truck
- i must pay now
- a ticket
- fine for the

Agent replies: Understood, I'm telling dispatch. Don't pay anything before they call you.

Then asks:
1. How much do they say it is? [number]
2. Are they holding the truck or your documents? [yes/no]
3. When can you drive again? [number, minutes]

Dispatcher note: Driver was fined and may be held.

Careful: the stop itself is `inspection`. Move it here only when there is a penalty, a clamp, or documents taken.

---

## traffic — level 1
Status: approved
Driver says:
- traffic
- jam
- construction
- road closed
- detour
- snow
- fog
- stuck in traffic
- traffic no moving
- cars not move
- bumper to bumper
- moving very slow
- big queue on highway
- highway blocked
- roadworks here
- one lane open
- lane closed, long line
- bridge closed
- they send us another way
- have to go around, road closed
- accident ahead, traffic stopped
- crash up ahead, I'm waiting in queue
- snow coming down heavy
- road full of snow
- ice on road, going slow
- very slippery
- fog, cannot see far
- heavy rain, slowing down
- wind very strong, going slow
- weather slowing me down
- traffic adding half hour
- gonna be late, big jam
- everything stopped on the highway
- police closed the highway ahead
- they turned us off at the exit
- a truck is burning in front, we wait
- a demonstration is blocking the road
- farmers blocking the road
- the road is flooded
- landslide on the road
- they closed the pass because of snow

Agent listens for:
- traffic
- jam
- backed up
- construction
- weather
- snow
- ice
- rain
- fog
- wind
- road closed
- detour
- accident ahead
- up ahead
- waiting in queue
- moving very slow
- very slow
- closed the highway
- highway ahead

Agent replies: Thanks — I'll update the ETA.

Then asks:
1. How much time do you think you'll lose? [number, minutes]

Dispatcher note: Driver reports traffic or weather.

Careful: the queue that dispatch can shorten with a phone call is `border` or `ferry`; this block is the road itself. "Accident ahead" stays here — it is not the driver's accident. Never the bare word "highway": drivers report being on it when everything is fine.

---

## parking — level 1
Status: proposed
Driver says:
- I cannot find parking
- the parking is full
- all places are taken
- no free place for the night
- trucks are standing on the entrance already
- I have to drive further to find parking
- the next parking is fifty kilometers
- I do not want to sleep on the ramp
- this parking is not safe
- no lights, no fence, I do not stay here
- they do not allow overnight parking here
- the customer does not let me stay in the yard
- security sent me away from the parking
- I must pay for parking, is it OK
- I found a place but it is far from the road
- I am parked on the shoulder for the night
- the rest area is closed
- gate at the truck stop is closed

Agent listens for:
- cannot find parking
- parking is full
- places are taken
- no free place
- for the night
- overnight parking
- rest area is closed
- parking is not safe
- drive further to find
- rest area
- pay for parking

Agent replies: Thanks — I'll note it and update the plan.

Then asks:
1. Where can you realistically stop? [text]
2. How much more driving time do you have? [number, minutes]

Dispatcher note: Driver cannot find parking for the rest.

Careful: if he is already out of hours and standing on the shoulder because of it, that is `hours` — the legal clock is the news, the parking is the detail.

---

## ferry — level 1
Status: proposed
Driver says:
- waiting for the ferry
- the ferry is late
- I missed the ferry
- next ferry in three hours
- the ferry is full
- they did not take me on this boat
- the ferry is cancelled, bad weather
- the sea is too rough, no sailing
- I am on the boat now
- I am on the shuttle
- waiting for the train
- the tunnel shuttle is delayed
- they are loading us on the train
- queue for the tunnel
- checking in for the ferry
- the port is closed
- strike in the port
- waiting for the pilot boat
- I am in the port queue since two hours

Agent listens for:
- ferry
- the boat
- shuttle
- the port
- crossing
- waiting for the train
- sea is too rough
- port queue
- is cancelled
- on the train
- port is closed

Agent replies: Thanks — I'll update the ETA.

Then asks:
1. When does the crossing leave? [number, minutes]

Dispatcher note: Driver is waiting for a ferry, shuttle, or train.

Careful: a queue at a national border is `border`, even in a port. This block is the crossing itself.

---

## phone — level 1
Status: proposed
Driver says:
- my phone is dying
- battery almost empty
- phone battery is low
- my phone died before
- I have no signal here
- no network in the mountains
- signal is very bad
- I have no internet
- my data is finished
- no roaming here
- the app is not working
- the page does not open
- the link does not work
- I cannot open what you sent
- location sharing stopped
- the phone asks something about location
- I closed the app by mistake
- my phone restarted
- charger is broken
- I will be offline for some time
- I was in a tunnel, no signal

Agent listens for:
- my phone
- battery
- no signal
- no network
- no internet
- my data
- roaming
- the app
- link does not work
- location sharing
- phone restarted
- charger
- offline
- in a tunnel

Agent replies: Thanks for telling me — that explains the gap. Turn the page back on when you can.

Then asks:
1. Can you get the tracking page open again? [yes/no]
2. Will you have signal for the next hour? [yes/no]

Dispatcher note: Driver's phone or signal is the reason for the silence.

Careful: this is the answer to "gone dark", not a stop. The truck may be rolling perfectly. Never turn it into `all_good` — the tracking is still broken and the morning briefing should say so.

---
## rest — level 0
Status: approved
Driver says:
- bathroom
- coffee
- eating
- taking a break
- sleeping
- toilet stop
- need toilet
- stopped for bathroom
- quick restroom stop
- getting coffee
- coffee break
- stopped for lunch
- eating now
- getting something to eat
- food stop
- taking my break now
- on break
- parked for rest
- resting a little
- taking a nap
- stopped to sleep
- going to bed now
- parked up for the night
- taking thirty minutes rest
- just stretching legs
- smoking a cigarette
- washing my face
- taking a shower at the truck stop
- I am in the shop
- buying water
- waiting for my laundry
- calling my family, five minutes
- praying, ten minutes
- I stopped to cool down a little

Agent listens for:
- bathroom
- restroom
- pee
- rest
- nap
- sleep
- sleeping
- coffee
- food
- eat
- eating
- lunch
- breakfast
- dinner
- taking a break
- on my break
- on break

Agent replies: Got it, thanks.

Then asks:
1. How long? [number, minutes]

Dispatcher note: Driver stopped for rest, bathroom, or food.

Careful: the legal break is `hours`, even when the words are the same. If he says "my forty five" or "the tacho", it is `hours`.

---

## fuel — level 0
Status: approved
Driver says:
- fuel
- diesel
- filling up
- getting fuel
- fueling now
- fuelling now
- stopped for diesel
- putting diesel in
- at fuel pump
- filling the tank
- filling truck up
- diesel stop
- refueling truck
- topping up diesel
- in line for fuel
- waiting for pump
- pumping fuel now
- getting diesel at truck stop
- adding adblue
- filling adblue
- washing the truck after fuel
- the station is busy, waiting for a free pump
- fueling at the terminal before loading

Agent listens for:
- fuel
- fueling
- gas
- diesel
- fill up
- filling up
- pump

Agent replies: Got it.

Then asks: (none)

Dispatcher note: Driver stopped for fuel.

Careful: "the card does not work at the pump" is `payment`; "I ran out of diesel" is `breakdown`.

---

## arrived — level 0
Status: proposed
Driver says:
- I am here
- I arrived
- at the customer
- I am at the gate
- I am in the yard
- checked in at reception
- they gave me a dock
- on the ramp now
- backing to the dock
- unloading now
- they are unloading me
- loading now
- they are loading
- almost finished loading
- finished, papers signed
- I am empty
- unloaded, everything OK
- loaded and rolling
- leaving the customer now
- I am out of the yard
- delivery done
- signed, no remarks
- I am on the way to the second delivery

Agent listens for:
- i am here
- i arrived
- at the gate
- in the yard
- checked in
- gave me a dock
- on the ramp
- unloading now
- they are unloading
- loading now
- they are loading
- i am empty
- unloaded
- delivery done
- papers signed
- leaving the customer
- loaded

Agent replies: Thanks — noted.

Then asks:
1. Anything wrong with the load or the papers? [yes/no]

Dispatcher note: Driver reports arrival, loading, or departure.

Careful: the platform already sees arrival from the position. This block is for the words, so the driver is not asked "you have been stopped 15 minutes, everything OK?" while he is on the ramp. If the answer to the follow-up is anything but no, it is `documents`.

---

## language — level 0
Status: proposed
Driver says:
- I do not understand
- I no understand you
- what
- say again
- repeat please
- slower please
- speak slowly
- I do not speak English good
- can you write in Macedonian
- write me in my language
- I speak only a little English
- can somebody call me who speaks my language
- what does this mean
- who is writing me
- who are you
- are you a person
- is this a robot
- I did not read your message

Agent listens for:
- do not understand
- no understand
- say again
- repeat please
- speak slowly
- slower please
- speak english
- in macedonian
- are you a person
- is this a robot
- who are you
- what does this mean

Agent replies: No problem — I'm the dispatch assistant. In one sentence: is everything OK with the truck and the load?

Then asks:
1. Is everything OK with the truck and the load? [yes/no]

Dispatcher note: Driver did not understand the question.

Careful: this is not an answer, so the question stays open. If the second try is also this block, the agent stops asking and hands it to the dispatcher with the words verbatim — a driver who cannot read the messages should be phoned by a human, not messaged twice more.

---

## all_good — level 0
Status: approved
Driver says:
- ok
- all good
- fine
- no problem
- everything OK
- all okay here
- everything fine
- no issues
- no trouble
- truck running fine
- load all good
- I'm good
- doing fine
- everything normal
- nothing wrong
- yes, all good
- all is okay
- no delay, all good
- still on time, no problems
- going good
- no, no problem here
- nothing to report
- rolling now
- on my way
- moving again
- I am driving
- back on the road
- everything under control
- thank you, all fine

- I am on the highway, all fine
- on the highway now, no problem
Agent listens for:
- all good
- on my way
- rolling
- fine
- ok
- okay
- yes
- yep
- good
- no problem

Agent replies: Thanks, drive safe.

Then asks: (none)

Dispatcher note: Driver says all is well.

Careful: this block is last on purpose. It is the weakest claim a reply can make, so anything else that matches beats it — "all good, just the police stopped me" is `inspection`. Never the bare word "moving": "truck not moving" is the opposite of all good.

---

## (new situation — copy this block)
Heading: `## your_key — level 0–3` (lower case, underscores; that is the key the code will use)
Status: proposed

Driver says:
- (how drivers actually say it — as many as you can, messy is good)

Agent listens for:
- (the few distinctive phrases the classifier should key on)

Agent replies:

Then asks:
1. 

Dispatcher note:

Careful: (which neighbouring block could claim these words, and which one should win)

---

## Before you approve a new block

- [ ] Does an existing block already cover it? A phrasing added to an old block is always better than a new block.
- [ ] Is the level about who must wake up, not about how unpleasant it is?
- [ ] Would the dispatcher do something different for this than for its neighbour? If not, it is the same situation.
- [ ] Is every phrasing at least two words, or a word that means nothing else? Single ordinary words ("hit", "break", "closed", "gas") pull in sentences that are not this situation.
- [ ] Does each follow-up question fit in one breath, and does the driver know the answer without leaving the cab?
- [ ] Is the "Careful" line written?
- [ ] Has a human — not the agent — put their name on it?

---

# What drivers ask the agent

The agent may answer ONLY from what it knows about this load. Write the question the way a driver says it, and where the answer comes from. Anything not on this list gets "I'll ask dispatch."

| Driver asks | Answer comes from |
|---|---|
| Where am I delivering? / What's the address? / Where I go? / Delivery address please / Where's the receiver? / Where do I unload? / Send me destination / What address for this load? | the load's destination |
| When do I have to be there? / What time delivery? / When is this due? / What time I need arrive? / What's the deadline? / Latest I can get there? | the load's deadline |
| What's my ETA? / When will I get there? / What arrival time you have? / How long till I arrive? / What time am I getting there? | the live ETA |
| Am I late? / How much late I am? / Am I still on time? | the live ETA against the deadline |
| Can I take my break now? / Can I stop for break? / Is now my break time? / When's my planned break? / What time can I take break? | the plan's break window |
| Where can I take the break? / Is there a truck stop on the way? / Where is the next parking on my route? | the recommended rest stop on the plan |
| Who do I call? / Dispatcher number? / What's dispatch phone? / Who's my dispatcher? / Give me dispatch contact / What number for dispatch? | dispatcher name and phone |
| What is my load number? / What reference for the gate? / What do I say at reception? | the load reference |
| Where did I load? / Where I came from? | the load's origin |
| What am I pulling? / Which trailer? / Is it a tanker or a box? | the equipment on the load |
| How far is it still? / How many kilometers left? | the remaining distance on the plan |
| Which way do I go? / Is my route over the highway? | the planned route |
| Did you get my message? / Do you see my location? | the trip's own record |
| (add yours) | |

## What the agent must never answer by itself

If a driver asks any of these, the answer is *"I'll ask dispatch"* — and dispatch is actually told. An agent that invents one of these answers is worse than an agent that says nothing.

| Driver asks | Why the agent stays quiet |
|---|---|
| How much do I get paid for this? / Is there extra for the waiting? | Money is never in the load record, and a wrong number is a fight later. |
| What is my next load? / Where do I go after? | The next load is dispatch's decision, not a fact about this one. |
| Can I skip the break? / Can I drive a bit longer? | Never. The agent does not authorize breaking the law. |
| Can I go faster to make it? | The agent reports the ETA; it does not ask anyone to hurry. |
| Should I sign the damaged paper? | A claim decision belongs to a human. |
| Can I leave the trailer here? / Can I go home? | An operational decision with money attached. |
| Is my job safe? / Is the boss angry? | Not the agent's to say, in any wording. |
| Can you cancel the delivery? / Tell the customer it is my fault | The agent reports; it does not negotiate for the driver. |
| What did the dispatcher say about me? | The agent never repeats one human about another. |

---

# Traps — words that must not decide alone

Every line here was a wrong classification waiting to happen. Keep them in mind when adding phrasings.

| The words | Goes to | Why |
|---|---|---|
| accident ahead, traffic stopped | `traffic` | Somebody else's accident. Level 3 for a jam wakes a dispatcher for nothing. |
| I hit traffic / hit the brakes / hit the road | `traffic` or nothing | The bare word "hit" is ordinary English. Only "hit a car", "got hit", "hit the barrier" mean a collision. |
| rolled over the curb | not `accident` | "Rollover" means the truck is on its side. Keep the phrasings explicit: "I rolled the truck". |
| I need a break | `rest` | The driver's choice. Only "my forty five", "no more hours", "the tacho" make it `hours`. |
| the road is closed | `traffic` | Closed roads and closed customers share a word. Keep "they are closed" for the receiver. |
| brake / broke / break down | depends | Speech-to-text mixes all three. "Brakes not working" is `breakdown`; "taking a break" is `rest`. |
| smoke | depends | From the engine: `breakdown`. From the trailer or the load: `spill`. |
| leaking | depends | Oil or coolant: `breakdown`. Product, drums, or a tank: `spill`. |
| the seal is broken | depends | In a parking lot at night: `theft`. At the receiver with everything present: `documents`. |
| I am stuck | depends | In traffic: `traffic`. In the mud: `stuck`. |
| no fuel | depends | On the card: `payment`. In the tank on the hard shoulder: `breakdown`. At a pump: `fuel`. |
| the card does not work | `payment` | Not `documents` — this is money, not paper. |
| queue | depends | On the road: `traffic`. At customs: `border`. At the port: `ferry`. In the yard: `customer`. |
| all good, but the police stopped me | `inspection` | `all_good` is the weakest claim and loses every tie. |
| ok | `all_good` only if nothing else matched | A driver says "ok" before saying the real thing. |
| this is not the driver | `not_the_driver` | It stops the ladder. Never keep questioning that number. |
| I do not understand | `language` | Not an answer. The question stays open, and after the second try a human calls. |

---

# Scenarios — how a night actually goes

**These are written cases, not transcripts.** They are invented from patterns that repeat on this desk, and they are here so that a change to a level or a phrasing can be checked against a whole night rather than one sentence. Real recorded words go in the transcript table at the end of the file, and nowhere else.

Read them as: what the agent saw, what it did, and what the dispatcher woke up to.

## Scenario 1 — the flat on the E-75, 02:40
*Load MK-4471, Skopje → Belgrade, deadline 08:00. Teaches: level 3 works even when the words are broken.*

| Time | What happened | The agent | The dispatcher |
|---|---|---|---|
| 02:38 | Truck stationary on the hard shoulder, 3 km past the Kumanovo exit | — | — |
| 02:53 | Still stationary, 15 min, no planned stop within 800 m | Asks: *"You've been stopped 15 min near Kumanovo, everything OK?"* | — |
| 02:55 | Driver types: *"no breakdown, my, my tire broken, front right"* | `breakdown`, level 3. Replies *"Understood. Are you safe? Dispatch is being notified now."* | Email at 02:55, then the phone rings |
| 02:56 | *"yes I am on shoulder, triangle out"* | Records safe = yes | |
| 02:57 | *"cannot move, need tire service"* | Records movable = no, tow/mechanic = yes | |
| 03:01 | *"maybe 2 hours if they come fast"* | Records 120 min. New ETA 09:40, deadline missed | Customer email drafted, not sent |
| 03:04 | Dispatcher replies to the email: *send the customer email* | Sends the drafted ETA to the receiver | |

What this proves: the classifier does not need clean English, only the word "breakdown" or "tire" in a sentence that means it. What it costs if the level were 2: the tire service is called at 07:00 instead of 03:00.

## Scenario 2 — the receiver that was never open
*Load AT-8820, Munich → Graz, booking 06:00. Teaches: `customer` is level 2 for a reason.*

| Time | What happened | The agent | The dispatcher |
|---|---|---|---|
| 05:52 | Arrived at the destination, stationary | Arrival recorded | — |
| 06:20 | Still stationary at the gate | Asks *"everything OK?"* | — |
| 06:21 | *"nobody here, gate locked, no answer on phone"* | `customer`, level 2. Replies *"Understood, I'm telling dispatch."* | Email at 06:21 with the driver's words |
| 06:22 | *"security paper on gate says open 07:00"* | Records: someone to talk to = no, time = 39 min | |
| 07:05 | *"they opened, I am in the yard"* | `arrived`, level 0 | Morning briefing only |

What this proves: nothing was on fire, and a human still had to know at 06:21 — the booking was wrong, and the next three loads to that receiver were booked the same way.

## Scenario 3 — gone dark in the tunnels
*Load CH-1190, Ljubljana → Zürich. Teaches: `phone` explains a silence without pretending it is fine.*

| Time | What happened | The agent | The dispatcher |
|---|---|---|---|
| 21:40 | Last position on the A10, then nothing | — | — |
| 22:00 | 20 minutes with no fix | Asks *"I haven't seen your location for 20 minutes. Everything OK?"* | — |
| 22:00 | No answer | — | — |
| 22:10 | Still nothing | Asks again | — |
| 22:25 | Still nothing | Calls the driver. No answer | — |
| 22:30 | Call retry. Driver answers: *"tunnels, no signal, everything fine"* | `phone`, level 1. Replies *"Thanks for telling me — that explains the gap."* | Morning briefing: 50 minutes untracked, reason given by the driver |
| 22:34 | Positions start arriving again, 41 km further on | Ladder stopped, ETA recalculated | |

What this proves: the gap is still reported. If this had been classified `all_good`, the morning briefing would say the night was clean, and the next time the same road went quiet nobody would know it always does.

## Scenario 4 — out of hours, 38 km short
*Load DE-2077, Rotterdam → Duisburg, deadline 23:00. Teaches: `hours` moves the delivery, not the driver.*

| Time | What happened | The agent | The dispatcher |
|---|---|---|---|
| 20:44 | Stationary at a service area not on the plan | — | — |
| 20:59 | 15 minutes stopped | Asks *"everything OK?"* | — |
| 21:00 | *"my driving time is finished, I must take 11 hours, sorry"* | `hours`, level 2. Replies *"Understood… take your rest — I'll update the ETA from the time you can drive again."* | Email at 21:00 |
| 21:01 | *"I can drive at 08:00"* | Records 660 min. New ETA 08:40 tomorrow | Customer draft attached |
| 21:02 | *"I am parked, it is fine here"* | Records parked = yes | |

What this proves: the load is late by eleven hours and nobody has to be woken at three in the morning to find out. What it costs if this were level 0: the receiver hears about it when the truck does not arrive.

## Scenario 5 — four hours at Tabanovce
*Load MK-3312, Skopje → Sofia, chemicals, deadline 14:00. Teaches: `border` is not `traffic`.*

| Time | What happened | The agent | The dispatcher |
|---|---|---|---|
| 09:12 | Stationary in the border approach | — | — |
| 09:27 | 15 minutes stopped | Asks *"everything OK?"* | — |
| 09:28 | *"big queue at the border, adr trucks separate line"* | `border`, level 2 | Email at 09:28 |
| 09:29 | *"papers with me, agent is not open before 10"* | Records papers = with driver, wait unknown | |
| 09:40 | Dispatcher calls the customs agent | — | — |
| 11:55 | *"through, rolling"* | `all_good`, ladder stopped, ETA 14:35 | Draft ETA email to the customer |

What this proves: a jam the dispatcher can shorten with a phone call is a different situation from a jam nobody can do anything about, even though the driver is standing still in both.

## Scenario 6 — the tank that stopped heating
*Load TK-5541, Antwerp → Ludwigshafen, heated tank, product must stay above 40 °C. Teaches: `equipment` before it becomes `spill`.*

| Time | What happened | The agent | The dispatcher |
|---|---|---|---|
| 01:12 | Driver writes without being asked: *"the tank heating is not working, display says 36"* | `equipment`, level 2. Replies *"Understood, I'm telling dispatch."* | Email at 01:12 |
| 01:13 | *"load is fine, no leak"* | Records load OK = yes | |
| 01:13 | *"I can drive, but it is going down"* | Records drivable = yes, reading 36 | |
| 01:30 | Dispatcher reroutes to the Frankfurt terminal for steam | — | — |
| 03:02 | *"I smell product, something is dripping at the valve"* | `spill`, level 3. Replies with the safety line | Email and the phone call at 03:02 |

What this proves: two blocks, two levels, one night. The first message did not deserve a phone call and the second one did, and the difference is written down in advance instead of decided at three in the morning.

## Scenario 7 — the silence that was real
*Load PL-4004, Poznań → Berlin, deadline 04:00. Teaches: the ladder ends at a human.*

| Time | What happened | The agent | The dispatcher |
|---|---|---|---|
| 01:20 | Stationary at an unlit lay-by, not on the plan | — | — |
| 01:35 | 15 minutes stopped | Chat: *"You've been stopped 15 min near Świebodzin, everything OK?"* | — |
| 01:45 | No answer | Chat again | — |
| 02:00 | No answer, link never opened | SMS with the link | — |
| 02:15 | No answer | Calls. No answer | — |
| 02:20 | No answer | Calls once more. No answer | — |
| 02:21 | Ladder exhausted | Escalates | Email with the full ladder, then the phone rings: *"…no reply to two messages, one SMS, two calls. Last position: lay-by near Świebodzin at 01:20."* |

What this proves: the agent never guesses. It does not decide the driver is asleep, and it does not decide he is hurt. It says exactly what it did and what it saw, and a human decides at 02:21 instead of at 06:00.

## Scenario 8 — the one the library got wrong
*Load IT-7712, Verona → Villach. Teaches: how the library grows.*

| Time | What happened | The agent | The dispatcher |
|---|---|---|---|
| 23:41 | *"the brakes are smoking, I stopped"* | Matched `breakdown` (level 3, email + call) | Woken correctly, but the note says "breakdown" |
| 23:44 | Driver adds: *"there is fire on the wheel now"* | `spill` — but nothing in the library then connected smoking brakes to fire | Second email |
| 08:30 | Dispatcher writes on the reply: *reclassify as spill* | Correction stored with the raw words | |
| Morning | Same phrasing had appeared three times in six weeks | Proposes: add *"brakes are smoking"* and *"fire on the wheel"* to `spill` | A human approves it; the library version increments |

What this proves: the agent was right to wake someone and wrong about what it was, and the only thing that fixes the second part is a human approving a line in this file. Rules never rewrite themselves.

---

# Test lines

Every line here is run against the classifier on every build. This is the table a dispatcher edits after seeing the agent get something wrong: paste the line, write the block it should have landed in, and the build says whether it does. `(nothing)` means the agent must say *"Sorry, I didn't catch that"* rather than guess.

Lines that name a `proposed` block are reported as waiting, not failed — they start passing the day the block is approved.

| Line a driver could send | Must be |
|---|---|
| had to use the bathroom, rolling now | `rest` |
| stuck in traffic with a flat | `breakdown` |
| traffic jam, construction, road closed, and a flat | `traffic` |
| hit traffic on 35 | `traffic` |
| i hit some traffic | `traffic` |
| hit a car at the light | `accident` |
| accident ahead, traffic stopped | `traffic` |
| crash up ahead, I'm waiting in queue | `traffic` |
| rolled over the curb, no damage | (nothing) |
| oh shit forgot my wallet | (nothing) |
| asdf qwer zxcv | (nothing) |
| ok fine yes but police pulled me over | `inspection` |
| all good, rolling | `all_good` |
| PULLED OVER!! DOT inspection. | `inspection` |
| won't start | `breakdown` |
| won’t start | `breakdown` |
| No, I had a breakdown. My, the, my Thurs, my tire is broken. | `breakdown` |
| they are closed until 7 | `customer` |
| road closed, big detour | `traffic` |
| I am at the border, big queue | `border` |
| my driving time is finished, I stop here | `hours` |
| the fuel card does not work | `payment` |
| this is not the driver, wrong number | `not_the_driver` |
| my phone battery is almost empty | `phone` |
| everything fine, I got a fine for the tacho | `fine` |

---

# Real transcripts

Paste what was actually said, as it came out of the phone, and what it should have been understood as. These are gold — do not put invented lines in this table; invented ones go in the scenarios above.

| Date | Driver said (verbatim) | Should be | Notes |
|---|---|---|---|
| 2026-09-07 | No, I had a breakdown. My, the, my Thurs, my tire is broken. So please inform the the bus or the dispatcher, whoever about the case. | breakdown | speech-to-text mangled "tire"; classifier still got it |
| | | | |
