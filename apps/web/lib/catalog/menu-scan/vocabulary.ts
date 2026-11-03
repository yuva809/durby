/**
 * Words that appear on restaurant menus, in their usual spelling and casing, to correct OCR misreads
 * against (`suggest.ts`). Dishes and ingredients of South Asian, German, Italian, East Asian and
 * international menus, drinks, and the small words menus use (with, mit, und…). Data, not UI text:
 * a suggestion shows a word from the menu's own language. The organization's product and category
 * names are added at run time.
 */
const WORDS = `
and with without or of the in on a la al de du con per
mit ohne und oder vom von dazu nach art auf im in an zu
served serviert gravy sauce Soße Sauce raitha Raitha chutney Chutney sambar Sambar dal Dal dhal Dhal
pieces piece pcs Stück Stk portion Portion half full small medium large klein mittel groß
mild Mild medium Medium spicy Spicy hot Hot sweet Sweet sour Sour scharf Scharf Mittel-scharf
extra Extra special Special house House chef Chef classic Classic homemade hausgemacht frisch fresh
plain Plain vegetarian Vegetarian vegan Vegan veg Veg non Non mixed Mixed
Chicken Hähnchen Huhn Hühnchen Hähnchenbrust Mutton Lamb Lamm Beef Rind Rinder Rindfleisch Pork Schwein
Schweinefleisch Fish Fisch Prawn Prawns Shrimp Shrimps Garnelen Crab Squid Calamari Cuttlefish Seafood
Meeresfrüchte Egg Eggs Ei Eier Paneer Tofu Cheese Käse Mushroom Mushrooms Pilze Champignons Duck Ente
Turkey Pute Goat Ziege Lachs Salmon Tuna Thunfisch Bacon Speck Ham Schinken Sausage Wurst Bratwurst
Vegetable Vegetables Gemüse Potato Potatoes Kartoffel Kartoffeln Aloo Gobi Cauliflower Blumenkohl Spinach
Spinat Palak Saag Peas Erbsen Mattar Chickpea Chickpeas Kichererbsen Chana Channa Lentil Lentils Linsen
Okra Bhindi Eggplant Aubergine Brinjal Baingan Onion Onions Zwiebel Zwiebeln Garlic Knoblauch Ginger
Ingwer Chilli Chili Pepper Pfeffer Paprika Tomato Tomatoes Tomate Tomaten Carrot Carrots Karotte Karotten
Corn Mais Cabbage Kohl Beans Bohnen Coconut Kokos Kokosnuss Cashew Cashews Cashewnüsse Almond Mandel
Mandeln Nuts Nüsse Mango Pineapple Ananas Banana Banane Apple Apfel Lemon Zitrone Lime Limette Orange
Strawberry Erdbeere Chocolate Schokolade Vanilla Vanille Cream Sahne Butter Ghee Yoghurt Yogurt Joghurt
Curd Milk Milch Honey Honig Rice Reis Basmati Noodles Nudeln Bread Brot Brötchen Herbs Kräuter
Masala Curry Currys Korma Kurma Kuruma Vindaloo Madras Jalfrezi Bhuna Dopiaza Rogan Josh Saag Makhani
Tikka Tandoori Tandoor Kebab Kabab Seekh Shashlik Pepper Milagu Chettinad Gongura Kodi Goa Kadai Karahi
Kolhapuri Hyderabadi Malabar Kerala Ceylon Jaffna Devilled Deviled Butter Dum Biryani Biriyani Briyani
Pulao Pilau Pulav Fried Kottu Kothu Kothu Parotta Parota Paratha Porotta Naan Nan Roti Chapathi Chapati
Chapatti Poori Puri Kulcha Bhatura Appam Hoppers Hopper Idly Idli Idiyappam Dosa Dosai Masala Uttapam
Vada Vadai Pongal Upma Sambar Rasam Kesari Halwa Payasam Paal Sarkarai Gulab Jamun Kheer Kulfi Rasmalai
Jalebi Ladoo Laddu Watalappan Wattalappam Lassi Mango-Lassi Chai Masala-Chai Samosa Samosas Pakora Pakoras
Bhaji Bhajis Onion-Bhaji Papadam Papad Poppadom Appalam Pickle Achar Thali Meals Meal Buffet Wochentage
Wochenende Weekend Specials Friday Saturday Sunday Monday Tuesday Wednesday Thursday Freitag Samstag
Sonntag Montag Dienstag Mittwoch Donnerstag Lunch Dinner Breakfast Mittagstisch Mittagessen Abendessen
Frühstück Starters Starter Vorspeisen Vorspeise Appetizers Appetizer Mains Main Hauptgericht
Hauptgerichte Hauptspeisen Hauptspeise Desserts Dessert Nachspeisen Nachtisch Süßspeisen Sides Side
Beilagen Beilage Breads Brote Soups Soup Suppe Suppen Salads Salad Salat Salate Drinks Getränke
Beverages Beverage Snacks Snack Kids Kinder Kindermenü Menu Menü Combo Platter Box
South North Indian Indisch Indische Südindisch Südindisches Sri Lankan Lanka Thai
Soup Suppe Tomatensuppe Linsensuppe Hühnersuppe Gemüsesuppe Mulligatawny
Salad Salat Caesar Greek Mixed Gemischter Gurkensalat Gurke Cucumber Feta Olives Oliven Mozzarella
Pizza Margherita Margarita Salami Funghi Prosciutto Tonno Hawaii Diavola Quattro Stagioni Formaggi Calzone
Pasta Spaghetti Penne Tagliatelle Fusilli Lasagne Lasagna Ravioli Tortellini Gnocchi Risotto Bolognese
Carbonara Napoli Arrabbiata Pesto Aglio Olio Alfredo Bruschetta Antipasti Antipasto Focaccia Tiramisu
Panna Cotta Gelato Eis Eiscreme Ice Sorbet
Schnitzel Wiener Jäger Jägerschnitzel Zigeuner Rahm Rahmschnitzel Gulasch Goulash Braten Schweinebraten
Rinderbraten Sauerbraten Rouladen Roulade Knödel Klöße Spätzle Käsespätzle Pommes Frites Bratkartoffeln
Kartoffelsalat Rösti Sauerkraut Rotkohl Currywurst Frikadelle Frikadellen Bulette Leberkäse Maultaschen
Flammkuchen Zwiebelrostbraten Steak Rumpsteak Filet Hüftsteak Burger Cheeseburger Hamburger Sandwich Wrap
Toast Club Hot-Dog Nuggets Wings Fries Chips Fish-and-Chips Kebap Döner Dürüm Lahmacun Falafel Hummus
Humus Halloumi Gyros Souvlaki Tzatziki Pita Bifteki Moussaka
Sushi Maki Nigiri Sashimi Uramaki Temaki Inside-Out California Ramen Udon Soba Miso Tempura Teriyaki
Yakitori Gyoza Edamame Wonton Dim Sum Bao Pad Thai Green Red Yellow Panang Massaman Tom Yum Kha Satay Sate
Nasi Goreng Mie Bami Bihun Chow Mein Kung Pao Sweet-and-Sour Szechuan Peking Spring Roll Rolls
Frühlingsrolle Frühlingsrollen Pho Banh Mi Bibimbap Kimchi Bulgogi
Kuchen Torte Cake Cheesecake Käsekuchen Apfelstrudel Strudel Brownie Brownies Muffin Waffel Waffeln
Crêpes Crepes Pancakes Pfannkuchen Pudding Griespudding Mousse Creme Crème Brûlée Fruit Obst Obstplatte
Fruchtsalat Gulab-Jamun Sweets Sweet
Water Wasser Mineralwasser Sprudel Still Soda Cola Coke Fanta Sprite Lemonade Limonade Apfelschorle
Schorle Juice Saft Orangensaft Apfelsaft Mango-Saft Smoothie Shake Milkshake Lassi Iced Eistee Tea Tee
Chai Coffee Kaffee Espresso Cappuccino Latte Macchiato Americano Mocha Hot Chocolate Kakao Beer Bier Pils
Weizen Weißbier Radler Alkoholfrei Wine Wein Rotwein Weißwein Rosé Prosecco Sekt Champagne Cocktail
Cocktails Mocktail Mocktails Mojito Spritz Aperol Gin Tonic Rum Vodka Whisky Arrack Toddy Lion Kingfisher
Dum Fry Fried Grilled Gegrillt Gebraten Frittiert Gebacken Baked Roasted Steamed Gedämpft Stew Eintopf
Marinated Mariniert Crispy Knusprig Stuffed Gefüllt Roll Bowl Bowls Curry-Bowl Special
`;

export const MENU_VOCABULARY: readonly string[] = [...new Set(WORDS.split(/\s+/).filter(Boolean))];

/**
 * Dish groups for category suggestions: their keywords (lowercase) and their label key. A name's
 * group is the first that matches, so curries come before tandoori (`Chicken Tikka Masala`).
 */
export const DISH_GROUPS = [
  {
    key: 'breads',
    words: [
      'naan',
      'nan',
      'roti',
      'chapathi',
      'chapati',
      'chapatti',
      'paratha',
      'parotta',
      'porotta',
      'poori',
      'puri',
      'kulcha',
      'bhatura',
      'bread',
      'brot',
      'focaccia',
    ],
  },
  {
    key: 'desserts',
    words: [
      'dessert',
      'desserts',
      'kesari',
      'halwa',
      'payasam',
      'gulab',
      'jamun',
      'kheer',
      'kulfi',
      'rasmalai',
      'jalebi',
      'ladoo',
      'watalappan',
      'eis',
      'eiscreme',
      'ice',
      'sorbet',
      'gelato',
      'tiramisu',
      'cake',
      'kuchen',
      'torte',
      'pudding',
      'brownie',
      'mousse',
      'pancakes',
      'waffel',
      'strudel',
      'cheesecake',
    ],
  },
  {
    key: 'drinks',
    words: [
      'lassi',
      'juice',
      'saft',
      'cola',
      'coke',
      'fanta',
      'sprite',
      'tea',
      'tee',
      'chai',
      'coffee',
      'kaffee',
      'espresso',
      'cappuccino',
      'latte',
      'beer',
      'bier',
      'wine',
      'wein',
      'water',
      'wasser',
      'soda',
      'shake',
      'milkshake',
      'smoothie',
      'mojito',
      'lemonade',
      'limonade',
      'schorle',
      'cocktail',
      'mocktail',
      'eistee',
    ],
  },
  { key: 'biryani', words: ['biryani', 'biriyani', 'briyani', 'pulao', 'pilau'] },
  { key: 'soups', words: ['soup', 'suppe', 'rasam', 'mulligatawny', 'ramen', 'pho'] },
  {
    key: 'dosa',
    words: [
      'dosa',
      'dosai',
      'idly',
      'idli',
      'idiyappam',
      'uttapam',
      'vada',
      'vadai',
      'appam',
      'hoppers',
    ],
  },
  { key: 'kottu', words: ['kottu', 'kothu'] },
  { key: 'rice', words: ['rice', 'reis', 'nasi', 'risotto'] },
  { key: 'salads', words: ['salad', 'salat'] },
  {
    key: 'starters',
    words: [
      'starter',
      'vorspeise',
      'samosa',
      'pakora',
      'bhaji',
      'papadam',
      'bruschetta',
      'spring',
      'frühlingsrolle',
      'gyoza',
      'wings',
      'nuggets',
    ],
  },
  { key: 'pizza', words: ['pizza', 'calzone'] },
  {
    key: 'pasta',
    words: [
      'pasta',
      'spaghetti',
      'penne',
      'tagliatelle',
      'lasagne',
      'lasagna',
      'ravioli',
      'tortellini',
      'gnocchi',
    ],
  },
  {
    key: 'curries',
    words: [
      'curry',
      'masala',
      'korma',
      'kurma',
      'kuruma',
      'vindaloo',
      'madras',
      'jalfrezi',
      'makhani',
      'chettinad',
      'milagu',
      'gongura',
    ],
  },
  {
    key: 'tandoori',
    words: ['tandoori', 'tandoor', 'tikka', 'kebab', 'kabab', 'seekh', 'shashlik'],
  },
] as const;

export type DishGroup = (typeof DISH_GROUPS)[number]['key'];
