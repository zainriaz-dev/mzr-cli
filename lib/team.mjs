export function selectTeam(catalog,requested='') {
  if(!Array.isArray(catalog?.items)||catalog.items.length>20)throw Error('Invalid team catalog');
  const items=catalog.items;
  if(items.some(item=>!item||! /^[A-Za-z0-9_-]{1,64}$/.test(item.id)||!['active','invited'].includes(item.state)))throw Error('Invalid team catalog');
  if(requested){if(!items.some(item=>item.id===requested))throw Error('Selected team is not authorized');return requested;}
  const primary=items.find(item=>item.id==='mzr-books');
  if(primary)return primary.id;
  if(items.length===1)return items[0].id;
  throw Error(items.length?'Multiple teams available: select --team explicitly':'Active membership or invitation required');
}
