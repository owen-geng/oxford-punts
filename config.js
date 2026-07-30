// Supabase connection for the Oxford Punts ledger.
// The anon key is public by design: it only grants what Row Level Security
// and the database's own rules allow (read everything, write nothing directly).
window.OXFORD_PUNTS_CONFIG = {
  supabaseUrl: "https://gtscnzzvgrzpfjegjfkf.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0c2Nuenp2Z3J6cGZqZWdqZmtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0Mjg1MTYsImV4cCI6MjEwMTAwNDUxNn0.I5Pt0V6HHVi37asfha8suPzCbkNdDHfPcRpICIUYMec",
};
