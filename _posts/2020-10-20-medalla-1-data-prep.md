---
# front matter for Jekyll
title: "Data Pre-processing for the Medalla Data Challenge"
permalink: "/posts/medalla-data-prep/"
---
This article documents the pre-processing steps carried out for an entry into the [Medalla data challenge](https://ethereum.org/en/eth2/get-involved/medalla-data-challenge/). Like all the articles in this series, it is a conversion of a Jupyter notebook — the originals of which are saved in [this GitHub respository](https://github.com/pintail-xyz/medalla_analysis).

 Visualisations and analysis of this data can be found on the following pages:

- [Medalla Participation Rates: A Validator Taxonomy](/posts/medalla-validator-taxonomy)
- [The Medalla Network Under Stress](/posts/medalla-network-stress)
- [Eth2 Client Comparisons from Medalla Data](/posts/medalla-client-comparison)

The data used is taken from a [database dump](http://mdc.mcdee.net/chain-487600.dmp), kindly shared by Jim McDonald ([@jgm](https://twitter.com/jgm)) of [Attestant](https://www.attestant.io/), which includes beacon chain data for the first approxiamtely 15,000 epochs (up to around 11 October 2020). The schemas for the tables in this database are included in the separate [schemas](schemas) file. Jim has made his `chaind` process for extracting beacon chain data from an eth2 client [available for use](https://github.com/wealdtech/chaind), so the results in this article can be replicated and updated by first generating a database from `chaind` and your eth2 node of choice.

Special thanks also to Ben Edgington ([@benjaminion_xyz](https://twitter.com/benjaminion_xyz)) whose [Eth2 Annontated Spec](https://benjaminion.xyz/eth2-annotated-spec/phase0/beacon-chain/) has been a vital resource in understanding how the beacon chain works.

## Setup
First up, we import the Python libraries to be used in this analysis, connect to the `chaind` database and pull out some basic information about the data we have saved there:

<details><summary><code>input 1 [click to view code]</code></summary>

```python
# imports
import time

import psycopg2
from bitlist import bitlist
from IPython.display import clear_output
```

</details>

<details><summary><code>input 2 [click to view code]</code></summary>

```python
# open/restart connection to chaind database
try:
    cursor.close()
    connection.close()
except:
    pass

connection = psycopg2.connect(user="chain", host="127.0.0.1", database="chain", password="medalla")
cursor = connection.cursor()
```

</details>

<details><summary><code>input 3 [click to view code]</code></summary>

```python
# basic info about the dataset
cursor.execute("SELECT MAX(f_slot) FROM t_blocks")
latest_slot = cursor.fetchone()[0]
n_slots = latest_slot + 1
n_epochs = (n_slots - (n_slots % 32)) // 32
print(f"latest slot: {latest_slot}, latest complete epoch: {n_epochs - 1}")

cursor.execute("SELECT f_slot, f_root FROM t_blocks ORDER BY f_slot DESC LIMIT 1")
latest_block = cursor.fetchone()
slot, root = latest_block[0], latest_block[1].hex()
print(f"latest block root: {root}")
```

</details>

```
output:
    latest slot: 487600, latest complete epoch: 15236
    latest block root: 5a36cf6aee95f69a79e44ba6bcb8f81846d1704dc05e74e8e467c37fca4c29ca
```

## Database Modifications
Next we make a few changes to the postgresql database provided by `chaind`. The database includes all blocks observed by Jim's Teku node, including a number of *orphaned* blocks which did not become *canonical*, that is, part of the finalised chain. Working out which blocks are canonical and which are orphaned will be valuable later, so we create extra columns in the `t_blocks` and `t_attestations` tables to mark those blocks and the attestations which were included in them. We also create a new index on `t_attestations` to allow us to select attestations according to the hash of the block in which they were included.

We then add a new table, `t_validator_performance`, which we will populate later with information about how each validator performed for each of its assigned attestation duties.

Finally we modify the `t_validators` table, adding some more columns we will populate with information about when they started and finished attesting, and how many blocks they succesfully proposed.

<details><summary><code>input 4 [click to view code]</code></summary>

```python
# database modifications required for this analysis

start_time = time.time()

print("adding f_canonical column to t_blocks table", end='\r')
cursor.execute("ALTER TABLE t_blocks DROP COLUMN IF EXISTS f_canonical")
cursor.execute("ALTER TABLE t_blocks ADD COLUMN f_canonical BOOLEAN DEFAULT false")

print("adding f_canonical and f_correct columns to t_attestations table", end='\r')
cursor.execute("ALTER TABLE t_attestations DROP COLUMN IF EXISTS f_canonical")
cursor.execute("ALTER TABLE t_attestations ADD COLUMN f_canonical BOOLEAN DEFAULT false")

print("adding i_inclusion_block_root index to t_attestations table     ", end='\r')
cursor.execute("DROP INDEX IF EXISTS i_inclusion_block_root")
cursor.execute("CREATE INDEX i_inclusion_block_root ON t_attestations (f_inclusion_block_root)")

print("creating t_validator_performance table                          ", end='\r')
cursor.execute("DROP TABLE IF EXISTS t_validator_performance")
cursor.execute("CREATE TABLE t_validator_performance (f_slot bigint NOT NULL PRIMARY KEY, "
               "f_validator_index int[], f_performance int[], f_effectiveness float[], f_correct int[])")

print("adding additional columns to t_validators table                 ", end='\r')
cursor.execute("ALTER TABLE t_validators "
               "DROP COLUMN IF EXISTS f_first_attested_epoch, "
               "DROP COLUMN IF EXISTS f_latest_attested_epoch, "
               "DROP COLUMN IF EXISTS f_client, "
               "DROP COLUMN IF EXISTS f_proposed_count")
cursor.execute("ALTER TABLE t_validators "
               "ADD COLUMN f_first_attested_epoch int DEFAULT -1, "
               "ADD COLUMN f_latest_attested_epoch int DEFAULT -1, "
               "ADD COLUMN f_client text, "
               "ADD COLUMN f_proposed_count int")

connection.commit()

elapsed = time.strftime("%H:%M:%S",time.gmtime(time.time() - start_time))
clear_output()
print(f"completed database modifications in {elapsed}")
```

</details>

```
output:
    completed database modifications in 00:02:39
```

## Identifying Canonical Blocks
One of the properties of eth2's [Casper FFG](https://arxiv.org/pdf/1710.09437.pdf) finality process is that blocks can be *finalised*, that is, they become unrevertable. Over short timescales it is possible for the eth2 beacon chain to fork, just as with existing Proof-of-Work blockchains (including the existing eth1 chain). However, with sufficient validator participation (representing at least ⅔ of the total amount of staked ether), eventually the validator set reaches consensus on one *canonical* chain.

Also as in other blockchains, each block contains a hash of a *parent* — that is, a block at an earlier time identified as the previous block in the chain. Identiyfing all blocks in the canonical chain is therefore simply a matter of taking a recently-finalised block and tracking back through the chain via each block's parents. Helpfully, the most recent block in the `chaind` database used in this analysis *was* finalised, according to [beaconcha.in](https://beaconcha.in), so we will start tracking back from there. Any block not lying on this chain will be considered to be an orphan.

<details><summary><code>input 5 [click to view code]</code></summary>

```python
# identify canonical blocks

# block 5a36cf6aee95f69a79e44ba6bcb8f81846d1704dc05e74e8e467c37fca4c29ca indicated as finalised on beaconcha.in.
# consider all ancestors of this block to be canonical.

start_time = time.time()

while True:
    # mark current block as canonical
    cursor.execute(f"UPDATE t_blocks SET f_canonical = true WHERE f_root = '\\x{root}'")
    
    # mark attestations from this block as canonical
    cursor.execute(f"UPDATE t_attestations SET f_canonical = true WHERE f_inclusion_block_root = '\\x{root}'")
    
    # identify parent block
    cursor.execute(f"SELECT f_slot, f_parent_root FROM t_blocks WHERE f_root = '\\x{root}'")
    result = cursor.fetchone()
    
    # exit loop if this block's parent is not in database (or slot=0 in which case no parent)
    if not result:
        break
    
    slot, root = result[0], result[1].hex()
    
    # show progress info
    if slot % 32 == 0:
        seconds = time.time() - start_time
        elapsed = time.strftime("%H:%M:%S",time.gmtime(seconds))
        done = 1 - (slot+1) / n_slots
        left = time.strftime("%H:%M:%S",time.gmtime(seconds * (1 / done - 1)))
        print(f"working backwards through blocks / current slot: {slot} ({100*done:.2f}% complete) / "
              f"{elapsed} elapsed / {left} left     ", end='\r')

connection.commit()

clear_output()
print(f"finished (reached back to slot {slot:,}) in {elapsed}.")

cursor.execute("SELECT COUNT(*), SUM(f_canonical::int) FROM t_blocks")
result = cursor.fetchone()
orphan_ratio = 1 - result[1] / result[0]
print(f"database contains {result[0]:,} blocks of which {result[1]:,} are canonical "
      F"({100*orphan_ratio:.1f}% orphan blocks)")
```

</details>

```
output:
    finished (reached back to slot 0) in 00:33:26.
    database contains 358,048 blocks of which 349,856 are canonical (2.3% orphan blocks)
```

<details><summary><code>[click to view code]</code></summary>

```python
# (this code is an optimisation for the calculations below but has not been used)

# identify chain head for each slot
head = []
for slot in range(n_slots):
    cursor.execute(f"SELECT f_root FROM t_blocks WHERE f_slot = {slot} AND f_canonical")
    result = cursor.fetchone()
    if result:
        head_slot, head_root = slot, result[0].hex()
    head.append([head_slot, head_root])

# find the gap to the next canonical block at each slot
gap = 1
for i, h in enumerate(head):
    while i+gap < len(head) and head[i+gap][0] != i+gap:
        gap += 1
    h.append(gap)
    gap = 1
```

</details>

<details><summary><code>input 6 [click to view code]</code></summary>

```python
# check proportion of attestations from canoncial blocks broadly matches block orphan ratio
cursor.execute("SELECT COUNT(*), SUM(f_canonical::int) FROM t_attestations")
result = cursor.fetchone()

print(f"database contains {result[0]:,} attestations of which {result[1]:,} are canonical "
      f"({100 * (1 - result[1] / result[0]):.1f}% from orphan blocks)")
```

</details>

```
output:
    database contains 22,723,853 attestations of which 22,246,751 are canonical (2.1% from orphan blocks)
```

## Blockchain Time
For the eth2 beacon chain, the base unit of time is a *slot*. Slots occur regularly every 12 seconds, and in each slot a single canonical block may be produced (but some slots may be *empty* if no block for that slot is included in the finalised chain). A set of 32 slots is called an *epoch*, and in each epoch every active validator is expected to produce a single attestation. 

## Decoding Attestations
The majority of the analysis of the Medalla data will be concerned with *attestations*, that is, cryptographically-signed votes by individual validators on blocks they have evaluated and found to be valid. These attestations themselves constitute the bulk of the data included in subsequent blocks. The beacon chain's *aggregation* of these attestations and their signatures is one of the key advances which allows eth2 to include many validators in the consensus process, and therefore promote decentralisation. For the purposes of analysis however, we need to unpack aggregated attestations to understand the performance of individual validators.

Each active validator is allocated to a *committee* whose attestations will be comnined into a single aggregated attestation. Information on which validators were part of each committee is included in the `chaind` database `t_beacon_committees` table. The attestations themselves are saved in the `t_attestations` table, which includes a column, `f_aggregation_bits`, which is effectively a series of single-bit-flags indicating which validators were aggregated into the final attestation.

Ultimately different versions of aggregated attestations end up being included in the beacon chain, at different slots. Accordingly, an individual validator may appear in several of these attestations. How many slots after the the block being produced a validator manages to get their *first* attestation included may be thought of as measure of their performance — the sooner the attestation is included, the better (validator rewards also recognise this). This measure of performance on an individual attestation is called *inclusion distance* where an inclusion distance of 0 indicates the attestation was included at the very next slot, and an inclusion distance of 1 is the slot after (etc.).

The below cell calculates the *first inclusion distance* for each active validator, at each epoch. If the validator does not have an attestation included at all, the attestation is said to be *missed*, denoted by an inclusion distance of -1. We also calculate the [attestation effectiveness](https://www.attestant.io/posts/defining-attestation-effectiveness/) for each validator, as the inverse of the *adjusted inclusion distance*. Finally, we record whether each validator attested *correctly* — that is, did the block it voted for end up being finalised?

<details><summary><code>input 7 [click to view code]</code></summary>

```python
# decode attestations, calculate performance, identify first/latest attestation for each validator

def decode_attestation(aggregation_bits, committee):
    n_validators = len(committee)
    aggregation_bitlist = bitlist(aggregation_bits.tobytes()[::-1])[:-(n_validators+1):-1]
    attested = [True if bit == 1 else False for bit in aggregation_bitlist]
    return attested

cursor.execute("SELECT COUNT(*) FROM t_validators")
n_validators = cursor.fetchone()[0]
validator_info = [{"first_epoch":  -1, "latest_epoch": -1} for i in range(n_validators)]

start_time = time.time()
#last_update = 0

for slot in range(latest_slot):
    epoch = slot // 32
    # get committees of validators assigned for attestation this slot
    cursor.execute(f"SELECT f_committee FROM t_beacon_committees WHERE f_slot = {slot} ORDER BY f_index")
    result = cursor.fetchall()
    # committee_lookup is a list of committees (themselves lists of validator indices) for this slot
    committee_lookup = [result[committee_index][0] for committee_index in range(len(result))]
    # committee_performance is the inclusion distance if committee member attested, -1 otherwise
    committee_performance   = [[-1] * len(committee) for committee in committee_lookup]
    # committee_effectiveness is inverse of the adjusted inclusion distance (accounting for empty slots)
    committee_effectiveness = [[0]  * len(committee) for committee in committee_lookup]
    # committee_correct says whether each member of the committee voted for a canonical block
    committee_correct       = [[0]  * len(committee) for committee in committee_lookup]
    
    # work out when the first attestation opportunity for this slot was
    cursor.execute(f"SELECT MIN(f_slot) FROM t_blocks WHERE f_slot > {slot} AND f_canonical = true")
    earliest_inclusion_slot = cursor.fetchone()[0]
    min_distance = earliest_inclusion_slot - slot - 1
    
    # get the chain head at this slot
    cursor.execute(f"SELECT f_slot, f_root FROM t_blocks WHERE f_slot <= {slot} AND f_canonical "
                   f"ORDER BY f_slot DESC LIMIT 1")
    result = cursor.fetchone()
    head_slot, head_root = result[0], result[1].hex()
    
    # get all canonical attestations made for this slot
    cursor.execute(f"SELECT f_committee_index, f_inclusion_slot, f_aggregation_bits, "
                   f"f_inclusion_block_root, f_beacon_block_root FROM t_attestations "
                   f"WHERE f_slot = {slot} AND f_canonical ORDER BY f_inclusion_slot")
    attestations = cursor.fetchall()
    
    for attestation in attestations:
        committee_index, inclusion_slot, aggregation_bits = attestation[:3]
        inclusion_root, attestation_head_root = attestation[3].hex(), attestation[4].hex()
        
        correct = 1 if attestation_head_root == head_root else -1
        
        inclusion_distance = inclusion_slot - slot - 1
        committee_participation = decode_attestation(aggregation_bits, committee_lookup[committee_index])
        
        # record the shortest inclusion_distance for each member
        for position, participated in enumerate(committee_participation):
            if participated and (committee_performance[committee_index][position] == -1):
                committee_performance[committee_index][position] = inclusion_distance
                committee_effectiveness[committee_index][position] = 1 / (1 + inclusion_distance - min_distance)
                committee_correct[committee_index][position] = correct
        
    # flatten lookup tables
    validators_flat    = [el for committee in committee_lookup        for el in committee]
    performance_flat   = [el for committee in committee_performance   for el in committee]
    effectiveness_flat = [el for committee in committee_effectiveness for el in committee]
    correct_flat       = [el for committee in committee_correct       for el in committee]
    cursor.execute("INSERT INTO t_validator_performance VALUES (%s, %s, %s, %s, %s)",
                       (slot, validators_flat, performance_flat, effectiveness_flat, correct_flat))

    # save attestation performance/effectiveness and update first/latest attestation info
    for i, validator in enumerate(validators_flat):
        if performance_flat[i] != -1:
            validator_info[validator]['latest_epoch'] = epoch
            if validator_info[validator]['first_epoch'] == -1:
                validator_info[validator]['first_epoch'] = epoch
            
    seconds = time.time() - start_time
    elapsed = time.strftime("%H:%M:%S",time.gmtime(seconds))
    left = time.strftime("%H:%M:%S",time.gmtime(seconds * (n_slots / (slot+1)-1)))
    percentage = 100*(slot+1)/n_slots
    
    print(f"processing attestations: epoch {epoch} of {n_epochs} ({percentage:.2f}%) / "
          f"{elapsed} elapsed / {left} left       ", end='\r')

clear_output()
print(f"attestations processed in {elapsed}")

print("indexing validator performance table...", end='')
cursor.execute("CREATE INDEX i_epoch ON t_validator_performance (f_slot)")
print("done")

print("saving validator first/latest attestation epochs...", end='')
for validator_index, info in enumerate(validator_info):
    cursor.execute(f"UPDATE t_validators "
                   f"SET f_first_attested_epoch = {info['first_epoch']}, "
                   f"   f_latest_attested_epoch = {info['latest_epoch']}"
                   f"WHERE f_index = {validator_index}")
print("done")

connection.commit()
```

</details>

```
output:
    attestations processed in 02:23:47
    indexing validator performance table...done
    saving validator first/latest attestation epochs...done
```

## Identifying Validator Clients and Block Producers
There is no definitive way to identify which client software powers each validator — as long as a given client follows the protocol rules, it is equivalent to any other client from the perspective of the network. However, for the purposes of Medalla, many users chose to indicate what client they were using in the `graffiti` field in blocks they propose. Those aiming to collect [POAP non-fungible tokens (NFTs)](https://beaconcha.in/poap) will have set their validators to include a graffiti string indicating their eth1 deposit address, and ending with a letter A, B, C, D or E, corresponding to the Prysm, Lighthouse, Teku, Nimbus and Lodestar clients respectively. For example, the third block in the dataset has the graffiti `poapg4eM7/cwRi/ZhaZg0zp6b9A6JlcA` indicating the block was produced by the Prysm client. Other validators have included the full name of their client in the graffiti — the very next block includes the graffiti `Lighthouse/v0.2.0/f26adc0a`. It seems a reasonable guess that this block was produced by the Lighthouse client.

Of course, the graffiti field can be set to whatever the user running the validator chooses, including misleading information about the client being used. For the most part there is little reason to expect users would be untruthful, with the exception that some may have chosen to game the POAP system to collect NFTs for all clients without the hassle of actually installing and using them. Nonetheless, to make progress with our analysis we will need to assume that the majority of validators were honest. Where we have large numbers of validators indicating the use of a certain client therefore, we might expect to gain  some insight into how that client has performed in aggregate. We may need to be a little more cautious if there are clients with a very small number of validators indicating participation through their beacon chain graffiti.

For the purposes of this analysis, we will assume that any validator which consistently indicates a particular client through its graffiti is genuinely running the claimed client. Validators which appear to switch clients, or which refer to mulitple clients in their graffiti, will be excluded (NB This will exclude even users who genuinely have switched clients, since validators produce blocks only occasionally, and it would be impossible to know exactly when they switched).

The cell below iterates through all canonical blocks in the dataset and where available, uses the `graffiti` field to guess which client produced the blocks. If information from different blocks suggests different clients were used, the validator is marked as *ambiguous*. We also count up the total number of blocks proposed by each validator.

<details><summary><code>input 8 [click to view code]</code></summary>

```python
# determine validator clients from block graffiti, count proposed blocks per validator

clients = [''] * n_validators
block_counts = [0] * n_validators

cursor.execute(f"SELECT f_proposer_index, f_graffiti FROM t_blocks WHERE f_canonical = true")
proposer_info = cursor.fetchall()

start_time = time.time()
last_update = 0

for i, info in enumerate(proposer_info):
    validator_index, graffiti = info[0], info[1].tobytes().decode(errors='ignore').lower()
    
    block_counts[validator_index] += 1
    
    prior = clients[validator_index]
    
    if prior == "ambiguous":
        continue

    pr_flag = (graffiti[:4] == "poap" and graffiti[-1] == "a") or graffiti.find("prysm")      != -1
    li_flag = (graffiti[:4] == "poap" and graffiti[-1] == "b") or graffiti.find("lighthouse") != -1
    te_flag = (graffiti[:4] == "poap" and graffiti[-1] == "c") or graffiti.find("teku")       != -1
    ni_flag = (graffiti[:4] == "poap" and graffiti[-1] == "d") or graffiti.find("nimbus")     != -1
    lo_flag = (graffiti[:4] == "poap" and graffiti[-1] == "e") or graffiti.find("lodestar")   != -1
    n_flags = pr_flag + li_flag + te_flag + ni_flag + lo_flag
    
    if n_flags > 1:
        clients[validator_index] = "ambiguous"
    elif pr_flag:
        clients[validator_index] = "prysm"      if prior in ["", "prysm"]      else "ambiguous"
    elif li_flag:
        clients[validator_index] = "lighthouse" if prior in ["", "lighthouse"] else "ambiguous"
    elif te_flag:
        clients[validator_index] = "teku"       if prior in ["", "teku"]       else "ambiguous"
    elif ni_flag:
        clients[validator_index] = "nimbus"     if prior in ["", "nimbus"]     else "ambiguous"
    elif lo_flag:
        clients[validator_index] = "lodestar"   if prior in ["", "lodestar"]   else "ambiguous"
        
    # show progress info
    if time.time() - last_update > 0.05:
        last_update = time.time()
        seconds = time.time() - start_time
        elapsed = time.strftime("%H:%M:%S",time.gmtime(seconds))
        done = (i+1) / len(proposer_info)
        left = time.strftime("%H:%M:%S",time.gmtime(seconds * (1 / done - 1)))
        print(f"working through blocks / {100*done:.2f}% complete / "
              f"{elapsed} elapsed / {left} left", end='\r')

clear_output()
print(f"block proposers processed in {elapsed}")
print("saving validator info...", end='')
for i, client in enumerate(clients):
    cursor.execute("UPDATE t_validators SET f_client = %s, f_proposed_count = %s"
                   "WHERE f_index = %s", (client, block_counts[i], i))

connection.commit()
print("done")
```

</details>

```
output:
    block proposers processed in 00:00:01
    saving validator info...done
```
