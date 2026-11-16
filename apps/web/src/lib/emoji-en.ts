// English names and search words of the picker's emoji. The same
// characters in the same categories and order as emoji-ru.ts (a unit test
// checks it); loaded only when the interface speaks English.
//
// Format of a line: `emoji|name|more search words`.

import type { EmojiRaw } from './emoji-data.ts';

const RAW: EmojiRaw = [
  [
    'smileys',
    'Smileys',
    '😀',
    `😀|grinning face|smile happy joy
😃|big smile|happy joy
😄|smiling eyes|happy laugh
😁|beaming smile|happy grin teeth
😆|laughing|laugh lol
😅|sweat smile|phew awkward relief
😂|tears of joy|laugh lol haha
🤣|rolling on the floor laughing|laugh rofl lol
😊|blushing smile|happy pleased
😇|angel|halo innocent
🙂|slight smile|smile
🙃|upside-down face|irony silly
😉|wink|joke
😌|relieved|calm peace
😍|heart eyes|love crush
🥰|smiling face with hearts|love adore
😘|blowing a kiss|kiss love
😗|kiss|smooch
😙|kiss with smiling eyes|smooch
😚|kiss with closed eyes|smooch
😋|yummy|tasty food tongue
😛|tongue out|tease
😜|winking with tongue|joke silly
🤪|zany face|crazy silly
😝|squinting with tongue|tease
🤑|money face|rich cash
🤗|hug|hugs
🤭|oops|giggle hand over mouth
🤫|shush|quiet secret
🤔|thinking|hmm wonder
🤐|zipped mouth|secret quiet
🤨|raised eyebrow|doubt suspicious
😐|neutral face|meh
😑|expressionless|meh blank
😶|no mouth|silent speechless
😏|smirk|sly
😒|unamused|bored annoyed
🙄|eye roll|whatever
😬|grimace|awkward
🤥|liar|lie nose
😔|pensive|sad down
😪|sleepy|tired
🤤|drooling|yummy want
😴|sleeping|sleep zzz
😷|face mask|sick doctor
🤒|thermometer face|sick fever
🤕|head bandage|hurt injury
🤢|nauseated|sick gross
🤮|vomiting|sick
🤧|sneezing|cold flu
🥵|hot face|heat
🥶|cold face|freezing frost
🥴|woozy|dizzy tipsy
😵|dizzy face|dizzy
🤯|mind blown|shocked wow
🤠|cowboy|hat
🥳|party face|celebrate birthday
😎|cool|sunglasses
🤓|nerd|smart glasses
🧐|monocle|inspect curious
😕|confused|unsure
😟|worried|concerned
🙁|frowning|sad
😮|surprised|wow open mouth
😯|hushed|astonished
😲|astonished|shocked
😳|flushed|embarrassed blush
🥺|pleading face|please puppy eyes
😦|frowning with open mouth|surprised
😧|anguished|pain
😨|fearful|scared fear
😰|anxious with sweat|nervous worry
😥|sad but relieved|disappointed
😢|crying|tear sad
😭|sobbing|cry tears
😱|screaming in fear|scream horror
😖|confounded|upset
😣|persevering|struggle
😞|disappointed|sad
😓|downcast sweat|tired
😩|weary|tired
😫|exhausted|tired
🥱|yawning|bored tired
😤|steam from nose|frustrated proud
😡|pouting|rage furious
😠|angry|mad
🤬|swearing|curse angry
😈|smiling devil|imp mischief
👿|angry devil|imp
💀|skull|dead
💩|poo|poop
🤡|clown|silly
👻|ghost|boo
👽|alien|ufo
🤖|robot|bot
😺|grinning cat|cat smile
😸|grinning cat with smiling eyes|cat laugh
😻|heart eyes cat|cat love
🙈|see no evil|monkey shy
🙉|hear no evil|monkey
🙊|speak no evil|monkey secret`,
  ],
  [
    'people',
    'Gestures and people',
    '👍',
    `👍|thumbs up|yes like ok good
👎|thumbs down|no dislike bad
👌|ok hand|okay fine
✌️|victory hand|peace
🤞|crossed fingers|luck hope
🤟|love you gesture|love
🤘|rock on|horns metal
🤙|call me|phone shaka
👈|pointing left|left
👉|pointing right|right
👆|pointing up|up
👇|pointing down|down
☝️|index pointing up|attention one
✋|raised hand|stop high five
🤚|back of hand|hand
🖐️|hand with fingers splayed|five hand
🖖|vulcan salute|spock
👋|waving hand|hello hi bye
👏|clapping hands|applause bravo
🙌|raising hands|hooray celebrate
👐|open hands|hug
🤲|palms up together|prayer
🙏|folded hands|thanks please pray
🤝|handshake|deal agreement
✊|raised fist|power
👊|fist bump|punch
💪|flexed biceps|strong muscle
✍️|writing hand|write
💅|nail polish|manicure
👀|eyes|look see
👁️|eye|look
👂|ear|listen hear
👃|nose|smell
👅|tongue|taste
👄|mouth|lips kiss
🧠|brain|smart think
❤️‍🔥|heart on fire|love passion
👶|baby|child newborn
🧒|child|kid
👦|boy|kid son
👧|girl|kid daughter
🧑|person|adult
👨|man|dad husband
👩|woman|mom wife
🧓|older person|elderly
👴|old man|grandpa grandfather
👵|old woman|grandma grandmother
👨‍👩‍👧|family|parents daughter
👨‍👩‍👧‍👦|family with children|kids parents
👪|family|home
💑|couple with heart|love couple
💏|kiss|couple love
🤰|pregnant woman|pregnancy baby
🤱|breastfeeding|baby mother
👼|baby angel|cherub
🎅|santa claus|christmas new year
🤶|mrs claus|christmas
🧑‍⚕️|health worker|doctor nurse
🧑‍🍳|cook|chef kitchen
🧑‍🏫|teacher|school
🧑‍🎓|student|graduate
👮|police officer|cop
🙋|raising hand|me question
🙆|ok gesture|fine yes
🙅|no gesture|no stop
🤷|shrug|dunno whatever
🤦|facepalm|ugh
💁|tipping hand|info sassy
🧍|standing|stand
🚶|walking|walk
🏃|running|run hurry
💃|dancing woman|dance party
🕺|dancing man|dance party
🧘|yoga|meditation calm
🛌|in bed|sleep rest`,
  ],
  [
    'nature',
    'Animals and nature',
    '🐶',
    `🐶|dog|puppy pet
🐱|cat|kitten pet
🐭|mouse|
🐹|hamster|pet
🐰|rabbit|bunny
🦊|fox|
🐻|bear|
🐼|panda|
🐨|koala|
🐯|tiger|
🦁|lion|
🐮|cow|
🐷|pig|
🐸|frog|
🐵|monkey|
🐔|chicken|hen
🐧|penguin|
🐦|bird|
🐤|chick|baby bird
🦆|duck|
🦉|owl|
🐴|horse|
🦄|unicorn|magic
🐝|bee|honey
🐛|caterpillar|bug
🦋|butterfly|
🐌|snail|slow
🐞|ladybug|
🐢|turtle|slow
🐍|snake|
🐙|octopus|
🐠|tropical fish|fish
🐟|fish|
🐬|dolphin|
🐳|whale|
🐘|elephant|
🦒|giraffe|
🐕|dog|pet
🐈|cat|pet
🐿️|squirrel|chipmunk
🦔|hedgehog|
🐾|paw prints|pet
💐|bouquet|flowers
🌸|cherry blossom|flower spring
🌹|rose|flower love
🌷|tulip|flower spring
🌻|sunflower|flower summer
🌼|blossom|flower
🌱|seedling|plant sprout
🌲|evergreen tree|fir pine
🌳|tree|
🌴|palm tree|beach summer
🌵|cactus|desert
🍀|four leaf clover|luck
🍁|maple leaf|autumn fall
🍂|fallen leaves|autumn fall
🍄|mushroom|
🌍|earth|world globe
🌙|moon|night
⭐|star|
🌟|glowing star|shine
✨|sparkles|magic shine
⚡|lightning|zap electricity
🔥|fire|hot lit
🌈|rainbow|
☀️|sun|sunny weather
⛅|partly cloudy|weather
☁️|cloud|weather
🌧️|rain|weather
⛈️|thunderstorm|storm weather
❄️|snowflake|snow winter cold
☃️|snowman|snow winter
⛄|snowman without snow|winter
🌊|wave|sea ocean
💧|droplet|water
☔|umbrella with rain|rain`,
  ],
  [
    'food',
    'Food',
    '🍎',
    `🍏|green apple|fruit
🍎|red apple|fruit
🍐|pear|fruit
🍊|tangerine|orange fruit
🍋|lemon|fruit
🍌|banana|fruit
🍉|watermelon|fruit summer
🍇|grapes|fruit
🍓|strawberry|berry
🫐|blueberries|berry
🍒|cherries|berry
🍑|peach|fruit
🥭|mango|fruit
🍍|pineapple|fruit
🥥|coconut|
🥝|kiwi|fruit
🍅|tomato|vegetable
🍆|eggplant|aubergine vegetable
🥑|avocado|
🥦|broccoli|vegetable
🥒|cucumber|vegetable
🌶️|hot pepper|chili spicy
🌽|corn|
🥕|carrot|vegetable
🧄|garlic|
🧅|onion|
🥔|potato|
🍞|bread|
🥐|croissant|breakfast
🥖|baguette|bread
🧀|cheese|
🥚|egg|
🍳|fried egg|breakfast cooking
🥞|pancakes|breakfast
🥓|bacon|breakfast
🍗|chicken leg|meat
🍖|meat on bone|meat
🌭|hot dog|
🍔|burger|hamburger
🍟|french fries|fries chips
🍕|pizza|
🥪|sandwich|
🌮|taco|
🥗|salad|
🍲|soup|stew pot
🍝|spaghetti|pasta
🍜|noodles|ramen
🍣|sushi|
🥟|dumplings|
🍦|ice cream|dessert
🍰|cake|dessert
🎂|birthday cake|birthday party
🧁|cupcake|dessert
🍫|chocolate|sweet
🍬|candy|sweet
🍭|lollipop|sweet candy
🍯|honey|
🍪|cookie|biscuit
🍩|donut|doughnut
☕|coffee|tea hot drink
🍵|tea|green tea
🥛|milk|
🍼|baby bottle|milk
🧃|juice box|juice
🍷|wine|
🥂|clinking glasses|cheers toast
🍺|beer|
🍾|champagne|celebrate
🥤|drink|soda
🍽️|plate|dinner
🍴|fork and knife|eat dinner`,
  ],
  [
    'activity',
    'Activities and travel',
    '⚽',
    `⚽|soccer|football ball
🏀|basketball|ball
🏐|volleyball|ball
🎾|tennis|ball
🏓|ping pong|table tennis
🏒|ice hockey|hockey
🥅|goal net|goal
⛳|golf|flag
🎣|fishing|fish
🎿|skis|ski winter
⛸️|ice skate|skating winter
🏆|trophy|cup win
🥇|gold medal|first win
🥈|silver medal|second
🥉|bronze medal|third
🏅|medal|sports
🎯|bullseye|target
🎮|video game|game controller
🎲|die|dice game
🧩|puzzle|jigsaw
🎨|palette|art paint
🎭|theater|masks
🎬|clapper board|movie film cinema
🎤|microphone|sing karaoke
🎧|headphones|music
🎵|musical note|music
🎶|musical notes|music song
🎹|piano|keyboard music
🎸|guitar|music
🎻|violin|music
🎉|party popper|celebrate congrats
🎊|confetti ball|celebrate party
🎈|balloon|party birthday
🎁|gift|present birthday
🎄|christmas tree|new year holiday
🎆|fireworks|celebrate new year
🎃|jack-o-lantern|pumpkin halloween
🚗|car|drive
🚕|taxi|cab
🚌|bus|
🚑|ambulance|emergency
🚒|fire engine|fire truck
🚓|police car|police
🚲|bicycle|bike
🛴|kick scooter|scooter
🚂|locomotive|steam train
🚆|train|
🚇|metro|subway underground
✈️|airplane|plane flight travel
🚀|rocket|space launch
⛵|sailboat|boat
🚢|ship|cruise
⚓|anchor|sea
🏠|house|home
🏡|house with garden|home
🏢|office building|work
🏫|school|
🏥|hospital|
🏪|store|shop
⛪|church|
🏖️|beach|summer vacation
🏔️|mountains|snow
⛺|tent|camping
🗺️|map|world travel
🧳|luggage|suitcase travel
⏰|alarm clock|wake up time`,
  ],
  [
    'objects',
    'Objects',
    '💡',
    `📱|mobile phone|smartphone
💻|laptop|computer
🖥️|desktop computer|computer
⌚|watch|time
📷|camera|photo
📸|camera with flash|photo
📞|telephone receiver|call
☎️|telephone|phone call
📺|television|tv
📻|radio|
🔋|battery|charge
🔌|electric plug|power
💡|light bulb|idea
🔦|flashlight|torch
🕯️|candle|
💰|money bag|cash
💳|credit card|card pay
💵|dollar banknote|money cash
✉️|envelope|letter mail
📧|email|mail
📦|package|parcel box delivery
📝|memo|note write
📅|calendar|date
📆|tear-off calendar|date
📌|pushpin|pin
📎|paperclip|attach
✂️|scissors|cut
📚|books|read study
📖|open book|read
✏️|pencil|write
🖊️|pen|write
🔑|key|
🔒|locked|lock
🔓|unlocked|open lock
🔨|hammer|tool
🛠️|tools|repair
⚙️|gear|settings
🧲|magnet|
💊|pill|medicine
💉|syringe|vaccine shot
🩺|stethoscope|doctor
🧸|teddy bear|toy
🪑|chair|
🛏️|bed|sleep
🛒|shopping cart|shop
🎒|backpack|school bag
👓|glasses|
👕|t-shirt|clothes
👗|dress|clothes
👟|sneakers|shoes
👜|handbag|bag
🧦|socks|
💍|ring|wedding
💎|gem|diamond
🧹|broom|clean
🧺|basket|laundry
🧻|toilet paper|roll
🧼|soap|wash
🔔|bell|notification
📣|megaphone|announce
🔍|magnifying glass|search
🗑️|wastebasket|trash bin
⌛|hourglass|time wait`,
  ],
  [
    'symbols',
    'Symbols',
    '❤️',
    `❤️|red heart|love
🧡|orange heart|love
💛|yellow heart|love
💚|green heart|love
💙|blue heart|love
💜|purple heart|love
🖤|black heart|
🤍|white heart|
🤎|brown heart|
💔|broken heart|sad
❣️|heart exclamation|love
💕|two hearts|love
💞|revolving hearts|love
💓|beating heart|love
💗|growing heart|love
💖|sparkling heart|love
💘|heart with arrow|love cupid
💝|heart with ribbon|gift love
💯|hundred points|100 perfect
💢|anger symbol|angry
💥|collision|boom bang
💫|dizzy|stars
💦|sweat droplets|water splash
💨|dashing away|wind fast
💤|zzz|sleep
💬|speech balloon|chat message
💭|thought balloon|think
✅|check mark button|done yes
☑️|checked box|done
✔️|check mark|done yes
❌|cross mark|no wrong
❎|cross mark button|no
➕|plus|add
➖|minus|
❓|question mark|question
❗|exclamation mark|important
‼️|double exclamation|important
⚠️|warning|caution
🚫|prohibited|forbidden no
⛔|no entry|forbidden stop
🆗|ok button|okay
🆕|new button|new
🆘|sos button|help
🔴|red circle|
🟢|green circle|
🔵|blue circle|
⏩|fast forward|forward
⏪|rewind|back
▶️|play button|play
⏸️|pause button|pause
🔁|repeat|again loop
🔄|refresh|update loop
➡️|right arrow|next
⬅️|left arrow|back
⬆️|up arrow|up
⬇️|down arrow|down
♻️|recycling|recycle
🏳️|white flag|surrender
🏁|chequered flag|finish race
🇷🇺|flag of russia|russia
🔞|no one under eighteen|18+ adult`,
  ],
];

export default RAW;
