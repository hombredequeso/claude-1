Orders consist of a:
guid id
string description
status

Status values are: Created | Cancelled | Completed

The happy path for orders is for them to be created providing the id and description, then completed.
The only other path possible for orders is for them to be created then cancelled.
All other status state changes are illegal.

The description and id of an order can never change.

Possible operations for an order are:
create
cancel
complete

