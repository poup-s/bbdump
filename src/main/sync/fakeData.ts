/**
 * Word lists for realistic fakes (first names, last names, cities, streets). ASCII only and
 * no quote, so they fit emails and SQL literals as is. The MCP server has the same lists
 * (mcp-postgres/src/fakeData.ts): AI masking and anonymized copies give the same fakes.
 */
export const FIRST_NAMES = [
  'Camille', 'Lea', 'Manon', 'Chloe', 'Emma', 'Ines', 'Jade', 'Louise', 'Alice', 'Lina',
  'Sarah', 'Julia', 'Clara', 'Zoe', 'Anna', 'Nina', 'Eva', 'Rose', 'Lucie', 'Marie',
  'Hugo', 'Lucas', 'Louis', 'Gabriel', 'Arthur', 'Jules', 'Adam', 'Raphael', 'Paul', 'Tom',
  'Nathan', 'Leo', 'Noah', 'Ethan', 'Victor', 'Martin', 'Samuel', 'Theo', 'Maxime', 'Antoine',
  'Olivia', 'Sofia', 'Mila', 'Elena', 'Maya', 'Liam', 'Oscar', 'Felix', 'Marco', 'Daniel',
];

export const LAST_NAMES = [
  'Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau',
  'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier',
  'Morel', 'Girard', 'Andre', 'Mercier', 'Dupont', 'Lambert', 'Bonnet', 'Francois', 'Martinez', 'Legrand',
  'Garnier', 'Faure', 'Rousseau', 'Blanc', 'Guerin', 'Muller', 'Henry', 'Roussel', 'Nicolas', 'Perrin',
  'Morin', 'Mathieu', 'Clement', 'Gauthier', 'Dumont', 'Lopez', 'Fontaine', 'Chevalier', 'Robin', 'Masson',
];

export const CITIES = [
  'Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice', 'Nantes', 'Strasbourg', 'Montpellier', 'Bordeaux', 'Lille',
  'Rennes', 'Reims', 'Toulon', 'Grenoble', 'Dijon', 'Angers', 'Nimes', 'Brest', 'Tours', 'Limoges',
  'Amiens', 'Perpignan', 'Metz', 'Besancon', 'Orleans', 'Rouen', 'Caen', 'Nancy', 'Avignon', 'Poitiers',
  'Bruxelles', 'Geneve', 'Lausanne', 'Montreal', 'Quebec', 'Luxembourg', 'Namur', 'Liege', 'Annecy', 'Pau',
];

export const STREETS = [
  'rue de la Paix', 'rue des Lilas', 'avenue Victor Hugo', 'boulevard Voltaire', 'rue du Moulin', 'place de la Mairie',
  'rue des Ecoles', 'chemin des Vignes', 'rue Pasteur', 'avenue Jean Jaures', 'rue de la Gare', 'rue du Chateau',
  'impasse des Roses', 'allee des Chenes', 'rue Nationale', 'rue de la Republique', 'avenue de la Liberte', 'rue du Port',
  'rue des Jardins', 'quai des Peupliers', 'rue Jules Ferry', 'rue du Stade', 'route de la Foret', 'rue des Tilleuls',
];
