const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// Uniform pick from `n` choices using rejection sampling, so no choice is favoured by modulo bias.
function randomIndex(n: number): number {
  const limit = Math.floor(256 / n) * n;
  for (;;) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b < limit) return b % n;
  }
}

/** Short random id: 8 characters of [a-z0-9], about 2.8e12 possibilities. */
export function randomId(length = 8): string {
  let s = "";
  for (let i = 0; i < length; i++) s += ALPHABET[randomIndex(ALPHABET.length)];
  return s;
}

// Soft, food-and-fluff words for "cute" links. Lower-case ASCII only so ids stay URL-safe and readable.
export const CUTE_WORDS = [
  "acorn", "almond", "apple", "apricot", "bagel", "bamboo", "banana", "basil", "bean", "berry", "biscuit", "blossom", "blueberry", "boba", "bonbon", "brownie", "bubble", "bun", "bunny", "butter",
  "button", "cake", "candy", "caramel", "carrot", "cashew", "cherry", "chestnut", "chick", "chiffon", "chirp", "cinnamon", "clover", "cloud", "cocoa", "coconut", "cookie", "cotton", "cozy", "cream",
  "crepe", "crumb", "cuddle", "cupcake", "custard", "daisy", "dango", "dew", "dimple", "donut", "dough", "dream", "drizzle", "dumpling", "fern", "fig", "fizz", "flan", "fluff", "fluffy",
  "foam", "fudge", "gelato", "ginger", "glow", "grape", "gumdrop", "hazel", "honey", "hug", "jelly", "jam", "kiwi", "latte", "lemon", "lily", "lime", "lychee", "macaron", "mallow",
  "mango", "maple", "matcha", "meadow", "melon", "meringue", "milk", "mint", "mitten", "mocha", "mochi", "momo", "moss", "muffin", "nectar", "nibble", "noodle", "nori", "nougat", "nutmeg",
  "oat", "olive", "onigiri", "orange", "pancake", "papaya", "parfait", "pea", "peach", "peanut", "pear", "pebble", "pecan", "pepper", "petal", "pickle", "pie", "pillow", "pine", "pistachio",
  "plum", "biscotti", "pom", "popcorn", "poppy", "posy", "pretzel", "puddle", "pudding", "puff", "pumpkin", "purr", "quince", "radish", "raisin", "ramen", "raspberry", "ribbon", "rice", "ripple",
  "rose", "sage", "sakura", "scone", "seed", "sesame", "shortcake", "snooze", "snow", "snuggle", "soba", "sorbet", "souffle", "sprinkle", "sprout", "squish", "star", "strudel", "sugar", "sunny",
  "sushi", "sweet", "taffy", "tangerine", "tart", "tea", "teacup", "thistle", "toast", "toffee", "tofu", "truffle", "tulip", "udon", "velvet", "waffle", "walnut", "wasabi", "whisk", "willow",
  "wonton", "yam", "yuzu", "zest", "acorncap", "applepie", "babka", "beanie", "blini", "brioche", "candle", "cheddar", "churro", "crumble", "eclair", "fondue", "galette", "granola", "gyoza", "jasmine",
  "kabocha", "kimchi", "koala", "lavender", "lentil", "marzipan", "mascot", "miso", "nacho", "nectarine", "omelet", "panda", "paprika", "pastel", "penguin", "persimmon", "pinecone", "pixel", "plushie", "praline",
  "puffin", "quokka", "rabbit", "risotto", "rosemary", "saffron", "seal", "shiba", "smore", "sparrow", "squirrel", "tamago", "tapioca", "teddy", "tiramisu", "tortilla", "turnip", "vanilla", "whiskers", "yogurt",
  "anise", "azuki", "bluebell", "bramble", "buckwheat", "buttercup", "calico", "camellia", "canary", "chai", "chamomile", "citrus", "clementine", "cobble", "comet", "coral", "cornbread", "cranberry", "daikon", "dandelion",
  "doodle", "duckling", "edamame", "elderberry", "feather", "firefly", "flapjack", "frost", "gingko", "gooseberry", "guava", "hamster", "hedgehog", "hibiscus", "huckleberry", "icing", "jujube", "kitten", "kumquat", "ladybug",
  "lantern", "lilac", "loquat", "lullaby", "marshmallow", "minnow", "mulberry", "oolong", "orchid", "otter", "peony", "pinwheel", "plover", "pomelo", "puppy", "robin", "sundae", "teapot", "tinsel", "wren",
];

/** "word-word-NN": easy to read aloud, but only a few million combinations, so easier to guess than randomId(). */
export function cuteId(): string {
  const a = CUTE_WORDS[randomIndexLarge(CUTE_WORDS.length)];
  let b = a;
  while (b === a) b = CUTE_WORDS[randomIndexLarge(CUTE_WORDS.length)];
  return `${a}-${b}-${10 + randomIndexLarge(90)}`;
}

function randomIndexLarge(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const [v] = crypto.getRandomValues(new Uint32Array(1));
    if (v < limit) return v % n;
  }
}

export const RANDOM_ID_RE = /^[a-z0-9]{8}$/;
export const CUTE_ID_RE = /^[a-z]+-[a-z]+-[1-9][0-9]$/;

export function isFileId(id: string): boolean {
  return RANDOM_ID_RE.test(id) || CUTE_ID_RE.test(id);
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Secret handed to the uploader once; only its SHA-256 is stored. */
export function deleteToken(): string {
  return "d_" + base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export function albumDeleteToken(): string {
  return "a_" + base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export { base64url };
