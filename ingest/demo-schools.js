'use strict';

// Schools for the offline demo. Names and conferences match the Power Four plus Notre Dame.
// Live ingest takes names, conferences, colors and alternate colors from CollegeFootballData instead.
// Demo colors are generated placeholders, not the schools' official colors.

const CONF = { SEC: 'SEC', BIG10: 'Big Ten', BIG12: 'Big 12', ACC: 'ACC', IND: 'FBS Independents' };

const LIST = [
  ['SEC', 'Alabama', 'ALA'], ['SEC', 'Arkansas', 'ARK'], ['SEC', 'Auburn', 'AUB'], ['SEC', 'Florida', 'FLA'],
  ['SEC', 'Georgia', 'UGA'], ['SEC', 'Kentucky', 'UK'], ['SEC', 'LSU', 'LSU'], ['SEC', 'Mississippi State', 'MSST'],
  ['SEC', 'Missouri', 'MIZ'], ['SEC', 'Oklahoma', 'OU'], ['SEC', 'Ole Miss', 'MISS'], ['SEC', 'South Carolina', 'SC'],
  ['SEC', 'Tennessee', 'TENN'], ['SEC', 'Texas', 'TEX'], ['SEC', 'Texas A&M', 'TAMU'], ['SEC', 'Vanderbilt', 'VAN'],

  ['BIG10', 'Illinois', 'ILL'], ['BIG10', 'Indiana', 'IND'], ['BIG10', 'Iowa', 'IOWA'], ['BIG10', 'Maryland', 'MD'],
  ['BIG10', 'Michigan', 'MICH'], ['BIG10', 'Michigan State', 'MSU'], ['BIG10', 'Minnesota', 'MINN'], ['BIG10', 'Nebraska', 'NEB'],
  ['BIG10', 'Northwestern', 'NU'], ['BIG10', 'Ohio State', 'OSU'], ['BIG10', 'Oregon', 'ORE'], ['BIG10', 'Penn State', 'PSU'],
  ['BIG10', 'Purdue', 'PUR'], ['BIG10', 'Rutgers', 'RUT'], ['BIG10', 'UCLA', 'UCLA'], ['BIG10', 'USC', 'USC'],
  ['BIG10', 'Washington', 'UW'], ['BIG10', 'Wisconsin', 'WIS'],

  ['BIG12', 'Arizona', 'ARIZ'], ['BIG12', 'Arizona State', 'ASU'], ['BIG12', 'Baylor', 'BAY'], ['BIG12', 'BYU', 'BYU'],
  ['BIG12', 'Cincinnati', 'CIN'], ['BIG12', 'Colorado', 'COLO'], ['BIG12', 'Houston', 'HOU'], ['BIG12', 'Iowa State', 'ISU'],
  ['BIG12', 'Kansas', 'KU'], ['BIG12', 'Kansas State', 'KSU'], ['BIG12', 'Oklahoma State', 'OKST'], ['BIG12', 'TCU', 'TCU'],
  ['BIG12', 'Texas Tech', 'TTU'], ['BIG12', 'UCF', 'UCF'], ['BIG12', 'Utah', 'UTAH'], ['BIG12', 'West Virginia', 'WVU'],

  ['ACC', 'Boston College', 'BC'], ['ACC', 'California', 'CAL'], ['ACC', 'Clemson', 'CLEM'], ['ACC', 'Duke', 'DUKE'],
  ['ACC', 'Florida State', 'FSU'], ['ACC', 'Georgia Tech', 'GT'], ['ACC', 'Louisville', 'LOU'], ['ACC', 'Miami', 'MIA'],
  ['ACC', 'NC State', 'NCST'], ['ACC', 'North Carolina', 'UNC'], ['ACC', 'Pittsburgh', 'PITT'], ['ACC', 'SMU', 'SMU'],
  ['ACC', 'Stanford', 'STAN'], ['ACC', 'Syracuse', 'SYR'], ['ACC', 'Virginia', 'UVA'], ['ACC', 'Virginia Tech', 'VT'],
  ['ACC', 'Wake Forest', 'WAKE'],

  ['IND', 'Notre Dame', 'ND']
];

// Other FBS teams. The ingest must drop these, which is what the demo checks.
const OTHER_FBS = [
  { school: 'Boise State', abbreviation: 'BSU', conference: 'Mountain West' },
  { school: 'Memphis', abbreviation: 'MEM', conference: 'American Athletic' },
  { school: 'Tulane', abbreviation: 'TUL', conference: 'American Athletic' },
  { school: 'Liberty', abbreviation: 'LIB', conference: 'Conference USA' },
  { school: 'Army', abbreviation: 'ARMY', conference: 'FBS Independents' },
  { school: 'UNLV', abbreviation: 'UNLV', conference: 'Mountain West' }
];

const POWER_FOUR = LIST.map(([key, school, abbreviation]) => ({ school, abbreviation, conference: CONF[key] }));

module.exports = { POWER_FOUR, OTHER_FBS };
