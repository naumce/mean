import { pick } from "./prng.mjs";

// Fixed name lists for the bulk driver population. Deliberately ONE flat
// list per part (first/last) mixing many origins with no per-name "origin"
// tag anywhere — a hard rule for this task: the world records evidence
// (assignments, pings, agent events), never a subjective or demographic
// label. `languages.mjs`'s job, not this file's, is picking which of a
// driver's languages they speak; these are just names.
//
// The 15 scenario-cast drivers (seed-world/cast.mjs) use their OWN fixed,
// hand-picked names and are never drawn from this pool, so a bulk driver can
// never accidentally collide with a named scenario identity.

export const FIRST_NAMES = [
  "James", "Michael", "Robert", "David", "William", "Joseph", "Charles", "Thomas",
  "Daniel", "Matthew", "Anthony", "Kevin", "Brian", "Eric", "Jason", "Gregory",
  "Maria", "Linda", "Susan", "Karen", "Patricia", "Nancy", "Sandra", "Angela",
  "Jose", "Luis", "Carlos", "Juan", "Miguel", "Pedro", "Rafael", "Diego",
  "Wei", "Ming", "Jun", "Hiroshi", "Kenji", "Yuki", "Soo-jin", "Min-ho",
  "Raj", "Amit", "Vikram", "Sanjay", "Priya", "Anita", "Deepak", "Arjun",
  "Ahmed", "Mohammed", "Hassan", "Youssef", "Fatima", "Layla", "Omar", "Tariq",
  "Chidi", "Kwame", "Kofi", "Amara", "Ngozi", "Femi", "Adaeze", "Emeka",
  "Boris", "Ivan", "Dmitri", "Katya", "Olga", "Natasha", "Viktor", "Nadia",
  "Piotr", "Krzysztof", "Andrzej", "Magda", "Ewa", "Tomasz", "Marek", "Aleksandra",
  "Stefan", "Marko", "Nikola", "Jovana", "Milica", "Vuk", "Zoran", "Ana",
  "Liam", "Noah", "Ethan", "Mason", "Logan", "Lucas", "Henry", "Owen",
  "Emma", "Olivia", "Ava", "Sophia", "Isabella", "Mia", "Charlotte", "Amelia",
  "Sean", "Connor", "Aidan", "Declan", "Fiona", "Siobhan", "Niamh", "Brendan",
  "Hans", "Klaus", "Dieter", "Ingrid", "Greta", "Lena", "Sven", "Anders",
  "Elena", "Sofia", "Nikos", "Dimitri", "Yiannis", "Katerina", "Alexis", "Christos",
];

export const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas",
  "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White",
  "Chen", "Wang", "Li", "Zhang", "Liu", "Yang", "Huang", "Zhao",
  "Kim", "Park", "Choi", "Jung", "Kang", "Yoon", "Suzuki", "Tanaka",
  "Patel", "Sharma", "Singh", "Kumar", "Gupta", "Rao", "Nair", "Reddy",
  "Khan", "Ali", "Hassan", "Ibrahim", "Farah", "Abdullah", "Rahman", "Malik",
  "Okafor", "Okonkwo", "Adeyemi", "Mensah", "Diallo", "Osei", "Nwosu", "Abara",
  "Petrov", "Ivanov", "Volkov", "Kessler", "Yankov", "Popov", "Sokolov", "Novak",
  "Nowak", "Kowalski", "Wojcik", "Kaminski", "Lewandowski", "Zielinski", "Wisniewski", "Dabrowski",
  "Petrovski", "Ilic", "Jovanovic", "Kovacs", "Horvat", "Kovacevic", "Nikolic", "Vasic",
  "Bracken", "Whitfield", "Delgado", "Webb", "Morrow", "Fischer", "Bauer", "Richter",
  "Murphy", "Kelly", "Sullivan", "Walsh", "O'Brien", "Ryan", "Doyle", "Byrne",
  "Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Berg", "Lindqvist",
  "Papadopoulos", "Nikolaou", "Georgiou", "Antoniou", "Christodoulou", "Ioannou", "Vasilakis", "Stavros",
  "Zhou", "Wu", "Xu", "Sun", "Ma", "Guo", "Lin", "Chu",
];

// Languages available for communication (never an "origin" signal — several
// of these names/regions above would NOT pick the matching language, on
// purpose, since a driver's spoken language is a fact about them, not an
// inference from their name). `en` is universal; the rest are the brief's
// exact list.
export const SECOND_LANGUAGES = ["es", "mk", "sr", "pl", "pa"];

/** Deterministic "First Last" from two independent PRNG draws — collisions
 *  across ~163 drivers are cosmetically fine for a demo (a few duplicate
 *  names among 260,000 possible pairs is realistic, not a bug) and are never
 *  used as an identity key (email/externalId are, and those are always
 *  index-derived and therefore unique). */
export function randomFullName(rand) {
  const first = pick(rand, FIRST_NAMES);
  const last = pick(rand, LAST_NAMES);
  return { first, last, full: `${first} ${last}` };
}
