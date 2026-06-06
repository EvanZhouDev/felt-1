"""Hand-designed pair specs (§1).

Design (satisfies "mismatched = same topic, OPPOSITE vibe", not different topic):
  For each TOPIC we author one paragraph with a target vibe, and generate TWO
  images of the SAME topic:
    - congruent image  (vibe matches the text)  -> MATCHED pair
    - opposite  image  (vibe inverts the text)  -> MISMATCHED pair
  So topic is held constant within each matched/mismatched twin; only vibe moves.
  Topics span distinct vibes (calm, urgent, joyful, eerie, melancholy, ...) so the
  consistent signal across the set is vibe, not subject matter.

Each spec yields: a text item (paragraph) + 2 image items. 10 topics -> 20 pairs.
"""

# vibe_tags is the human label seed (§1) — later a steering target.
SPECS = [
    {
        "topic": "ocean",
        "text_vibe": "calm",
        "vibe_tags": "calm, serene, peaceful",
        "text_prompt": "Write a 4-5 sentence vivid paragraph about the ocean at dawn that feels deeply CALM and serene — slow, soft, peaceful. No metaphors about other topics; stay on the ocean.",
        "img_congruent": "a calm serene ocean at dawn, glassy still water, soft pastel light, peaceful, tranquil, gentle, photographic",
        "img_opposite": "a violent stormy ocean, towering crashing waves, dark chaotic sky, dangerous tempest, dramatic, photographic",
        "opposite_vibe": "violent, chaotic, threatening",
    },
    {
        "topic": "city street",
        "text_vibe": "urgent",
        "vibe_tags": "urgent, frantic, tense",
        "text_prompt": "Write a 4-5 sentence vivid paragraph about a city street that feels URGENT and frantic — rushing, tense, high-pressure. Stay on the city street.",
        "img_congruent": "a frantic rush-hour city street, blurred sprinting crowds, urgent motion, harsh red lights, chaotic energy, photographic",
        "img_opposite": "an empty quiet city street at calm early morning, soft light, still, peaceful, serene, nobody around, photographic",
        "opposite_vibe": "calm, empty, quiet",
    },
    {
        "topic": "forest",
        "text_vibe": "eerie",
        "vibe_tags": "eerie, unsettling, ominous",
        "text_prompt": "Write a 4-5 sentence vivid paragraph about a forest that feels EERIE and unsettling — ominous, uncanny, quietly threatening. Stay on the forest.",
        "img_congruent": "an eerie misty dark forest at dusk, twisted bare trees, ominous fog, unsettling, cold, foreboding, photographic",
        "img_opposite": "a bright cheerful sunlit forest glade, warm golden light, lush green, inviting, joyful, wildflowers, photographic",
        "opposite_vibe": "cheerful, warm, inviting",
    },
    {
        "topic": "birthday party",
        "text_vibe": "joyful",
        "vibe_tags": "joyful, celebratory, warm",
        "text_prompt": "Write a 4-5 sentence vivid paragraph about a birthday party that feels JOYFUL and celebratory — warm, bright, full of delight. Stay on the party.",
        "img_congruent": "a joyful colorful birthday party, balloons confetti bright cake, laughing people, warm festive light, celebratory, photographic",
        "img_opposite": "a lonely abandoned birthday party, deflated balloons, empty chairs, dim gray light, melancholy, nobody there, photographic",
        "opposite_vibe": "lonely, melancholy, abandoned",
    },
    {
        "topic": "bedroom",
        "text_vibe": "melancholy",
        "vibe_tags": "melancholy, lonely, wistful",
        "text_prompt": "Write a 4-5 sentence vivid paragraph about a bedroom on a rainy afternoon that feels MELANCHOLY and lonely — wistful, muted, sad. Stay on the bedroom.",
        "img_congruent": "a melancholy bedroom on a rainy afternoon, muted gray light, rain on window, lonely, empty, wistful, desaturated, photographic",
        "img_opposite": "a cozy warm bright bedroom in morning sun, golden cheerful light, inviting, comfortable, happy, vibrant, photographic",
        "opposite_vibe": "cozy, warm, cheerful",
    },
    {
        "topic": "mountain",
        "text_vibe": "awe",
        "vibe_tags": "awe, majestic, sublime",
        "text_prompt": "Write a 4-5 sentence vivid paragraph about a mountain peak that feels full of AWE and grandeur — majestic, sublime, breathtaking. Stay on the mountain.",
        "img_congruent": "a majestic towering mountain peak, vast sublime vista, dramatic golden light, awe-inspiring grandeur, epic, photographic",
        "img_opposite": "a small dull gray hill on an overcast boring day, flat lighting, unremarkable, mundane, dreary, photographic",
        "opposite_vibe": "dull, mundane, dreary",
    },
    {
        "topic": "kitchen",
        "text_vibe": "cozy",
        "vibe_tags": "cozy, warm, comforting",
        "text_prompt": "Write a 4-5 sentence vivid paragraph about a kitchen in the evening that feels COZY and comforting — warm, homely, safe. Stay on the kitchen.",
        "img_congruent": "a cozy warm kitchen in the evening, golden lamplight, steaming mug, homely comforting, soft inviting, photographic",
        "img_opposite": "a cold sterile clinical kitchen, harsh fluorescent light, bare metal surfaces, uninviting, stark, empty, photographic",
        "opposite_vibe": "cold, sterile, stark",
    },
    {
        "topic": "highway at night",
        "text_vibe": "lonely",
        "vibe_tags": "lonely, isolated, desolate",
        "text_prompt": "Write a 4-5 sentence vivid paragraph about a highway at night that feels LONELY and isolated — desolate, empty, solitary. Stay on the highway.",
        "img_congruent": "a lonely empty highway at night, single distant taillight, vast dark emptiness, isolated, desolate, solitary, photographic",
        "img_opposite": "a lively festive highway packed with bright traffic, glowing city lights, energetic bustle, vibrant, exciting, photographic",
        "opposite_vibe": "lively, vibrant, energetic",
    },
    {
        "topic": "garden",
        "text_vibe": "playful",
        "vibe_tags": "playful, whimsical, light",
        "text_prompt": "Write a 4-5 sentence vivid paragraph about a garden in spring that feels PLAYFUL and whimsical — light, bouncy, full of fun. Stay on the garden.",
        "img_congruent": "a playful whimsical spring garden, bright bouncing butterflies, cheerful flowers, light fun colorful, delightful, photographic",
        "img_opposite": "a grim overgrown dead garden, withered thorns, gray decay, somber, oppressive, lifeless, photographic",
        "opposite_vibe": "grim, dead, somber",
    },
    {
        "topic": "old house",
        "text_vibe": "nostalgic",
        "vibe_tags": "nostalgic, tender, bittersweet",
        "text_prompt": "Write a 4-5 sentence vivid paragraph about an old family house that feels NOSTALGIC and tender — bittersweet, warm with memory, gentle longing. Stay on the house.",
        "img_congruent": "an old family house bathed in warm nostalgic afternoon light, faded photos, tender bittersweet, soft sepia memory, photographic",
        "img_opposite": "a menacing haunted derelict house at night, sharp threatening shadows, frightening, hostile, horror, photographic",
        "opposite_vibe": "menacing, frightening, hostile",
    },
]
